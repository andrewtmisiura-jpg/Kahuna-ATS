import { NextResponse } from "next/server";
import { db } from "@/db";
import { firstMissingQuoSecret, getQuoWebhookSecret, noteQuoSecretFound } from "@/server/services/integration-secrets";
import { getProviders } from "@/server/services/messaging/providers";
import { handleQuoEvent, parseQuoEvent, readSignatureHeaders, verifyStandardWebhook } from "@/server/services/messaging/webhooks";
import { notifyAdmin } from "@/server/services/notify";

// Quo's message webhook (DATA_MODEL.md, send rule 7). The signature is checked
// against the raw body with the signing secret: QUO_WEBHOOK_SECRET from Railway
// first, else the integration_secret row `pnpm quo:setup` stored when it created
// the webhook (cached in memory for 5 minutes). With neither, it answers 503
// without reading the event and logs that once. After a valid signature the
// handler answers 200 whatever the event (unknown types and ids are logged, never
// errors) so Quo never disables the webhook. Only a thrown error answers 500, so
// Quo redelivers it, which is harmless because inbound inserts dedupe on the
// provider id and status updates only move forward.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  let secret: string | null;
  try {
    secret = (await getQuoWebhookSecret(db))?.secret ?? null;
  } catch (error) {
    console.error("[webhook:quo] could not read the signing secret", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "secret_unavailable" }, { status: 500 });
  }
  if (!secret) {
    if (firstMissingQuoSecret()) {
      console.warn("[webhook:quo] no signing secret (QUO_WEBHOOK_SECRET or the stored one from pnpm quo:setup); answering 503 until one exists");
      await notifyAdmin(db, "webhook_no_secret_quo", "Quo webhook has no signing secret", "Quo deliveries are refused with 503. The next deploy's quo:setup step says why; see Settings > Texting.");
    }
    return NextResponse.json({ error: "no_secret" }, { status: 503 });
  }
  noteQuoSecretFound();

  const verified = verifyStandardWebhook({
    secret,
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
