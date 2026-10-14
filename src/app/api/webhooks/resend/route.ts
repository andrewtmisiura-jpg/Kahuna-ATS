import { NextResponse } from "next/server";
import { db } from "@/db";
import { handleResendEvent, parseResendEvent, readSignatureHeaders, verifyStandardWebhook } from "@/server/services/messaging/webhooks";
import { notifyAdmin } from "@/server/services/notify";

// Resend's email webhook: svix-signed (svix-id, svix-timestamp, svix-signature)
// with RESEND_WEBHOOK_SECRET. Hard bounces and complaints add suppressions,
// delivery events move a message's status forward. Always 200 after a valid
// signature except for a thrown error, which Resend then redelivers.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  const verified = verifyStandardWebhook({
    secret: process.env.RESEND_WEBHOOK_SECRET,
    headers: readSignatureHeaders(request.headers, "svix"),
    body,
  });
  if (!verified.ok) {
    console.warn(`[webhook:resend] rejected: ${verified.reason}`);
    await notifyAdmin(db, "webhook_signature_resend", "Resend webhook signature failed", `Reason: ${verified.reason}`);
    return NextResponse.json({ error: verified.reason }, { status: verified.reason === "no_secret" ? 503 : 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    console.warn("[webhook:resend] body is not JSON, ignored");
    return NextResponse.json({ ok: true, ignored: "not_json" });
  }
  const event = parseResendEvent(payload);
  if (!event) {
    console.warn("[webhook:resend] payload has no event type, ignored");
    return NextResponse.json({ ok: true, ignored: "unrecognized" });
  }

  try {
    const outcome = await handleResendEvent(db, event);
    const detail = outcome.kind === "ignored" ? outcome.reason : `${outcome.status ?? "-"} changed=${outcome.changed} suppressed=${outcome.suppressed.length}`;
    console.log(`[webhook:resend] ${event.type} ${event.emailId ?? "?"}: ${outcome.kind} ${detail}`);
    return NextResponse.json({ ok: true, outcome: outcome.kind });
  } catch (error) {
    console.error("[webhook:resend] handler failed", error);
    await notifyAdmin(db, "webhook_resend_error", "Resend webhook handler failed", `${event.type} ${event.emailId ?? ""}: ${String(error)}`);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
