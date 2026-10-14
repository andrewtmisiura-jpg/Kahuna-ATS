import { NextResponse } from "next/server";
import { db } from "@/db";
import { getProviders } from "@/server/services/messaging/providers";
import { handleQuoEvent, parseQuoEvent, readSignatureHeaders, verifyStandardWebhook } from "@/server/services/messaging/webhooks";
import { notifyAdmin } from "@/server/services/notify";

// Quo's message webhook (DATA_MODEL.md, send rule 7). The signature is checked
// against the raw body with QUO_WEBHOOK_SECRET; after a valid signature the
// handler answers 200 whatever the event (unknown types and ids are logged, never
// errors) so Quo never disables the webhook. Only a thrown error answers 500, so
// Quo redelivers it, which is harmless because inbound inserts dedupe on the
// provider id and status updates only move forward.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  const verified = verifyStandardWebhook({
    secret: process.env.QUO_WEBHOOK_SECRET,
    headers: readSignatureHeaders(request.headers, "webhook"),
    body,
  });
  if (!verified.ok) {
    console.warn(`[webhook:quo] rejected: ${verified.reason}`);
    await notifyAdmin(db, "webhook_signature_quo", "Quo webhook signature failed", `Reason: ${verified.reason}`);
    return NextResponse.json({ error: verified.reason }, { status: verified.reason === "no_secret" ? 503 : 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    console.warn("[webhook:quo] body is not JSON, ignored");
    return NextResponse.json({ ok: true, ignored: "not_json" });
  }
  const event = parseQuoEvent(payload);
  if (!event) {
    console.warn("[webhook:quo] payload has no event type, ignored");
    return NextResponse.json({ ok: true, ignored: "unrecognized" });
  }

  try {
    const outcome = await handleQuoEvent(db, event, { providers: getProviders() });
    const detail = outcome.kind === "ignored" ? outcome.reason : outcome.kind === "inbound" ? outcome.outcome.kind : "";
    console.log(`[webhook:quo] ${event.type} ${event.messageId ?? "?"}: ${outcome.kind} ${detail}`.trimEnd());
    return NextResponse.json({ ok: true, outcome: outcome.kind });
  } catch (error) {
    console.error("[webhook:quo] handler failed", error);
    await notifyAdmin(db, "webhook_quo_error", "Quo webhook handler failed", `${event.type} ${event.messageId ?? ""}: ${String(error)}`);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
