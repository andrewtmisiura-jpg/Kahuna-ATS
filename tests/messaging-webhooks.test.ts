import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { consentEvent, employer, integrationSecret, message, suppression } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { resetQuoWebhookSecretCache } from "@/server/services/integration-secrets";
import { createSinkProviders } from "@/server/services/messaging/providers";
import {
  handleQuoEvent,
  handleResendEvent,
  isOptOutError,
  parseQuoEvent,
  parseResendEvent,
  readSignatureHeaders,
  verifyStandardWebhook,
  type QuoEvent,
} from "@/server/services/messaging/webhooks";
import { POST as quoPost } from "@/app/api/webhooks/quo/route";
import { POST as resendPost } from "@/app/api/webhooks/resend/route";
import { createApplication, createPerson, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

const PHONE_ID = "PNtest0001";
const HIRING_NUMBER = "+17632922259";
const NOON = new Date("2026-10-20T16:00:00Z");
const SECRET = "whsec_" + Buffer.from("a-test-signing-key-of-32-bytes!!").toString("base64");

let snow: SnowFixture;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  await db.update(employer).set({ smsQuoPhoneNumberId: PHONE_ID, smsEnabled: true }).where(eq(employer.id, employerId));
});

afterAll(async () => {
  await db.update(employer).set({ smsQuoPhoneNumberId: null }).where(eq(employer.id, employerId));
  await sql.end();
});

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function signedHeaders(body: string, options: { secret?: string; now?: Date; id?: string; prefix?: "webhook" | "svix" } = {}) {
  const prefix = options.prefix ?? "webhook";
  const id = options.id ?? `msg_${uuidv7()}`;
  const timestamp = String(Math.floor((options.now ?? new Date()).getTime() / 1000));
  return {
    [`${prefix}-id`]: id,
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: sign(options.secret ?? SECRET, id, timestamp, body),
    "content-type": "application/json",
  };
}

let seq = 0;
function quoMessageId() {
  seq += 1;
  return `AC${Date.now()}${seq}`;
}

type QuoObject = Record<string, unknown>;

function quoPayload(type: string, object: QuoObject) {
  return {
    id: `EV${uuidv7()}`,
    object: "event",
    type,
    createdAt: NOON.toISOString(),
    data: { object: { object: "message", phoneNumberId: PHONE_ID, createdAt: NOON.toISOString(), ...object } },
  };
}

function event(type: string, object: QuoObject): QuoEvent {
  return parseQuoEvent(quoPayload(type, object), NOON)!;
}

// An outbound text the send function would have left behind after a Quo send.
async function sentText(personId: string, applicationId: string, to: string, providerMessageId: string, status: "sent" | "delivered" = "sent") {
  const id = uuidv7();
  await db.insert(message).values({
    id,
    direction: "outbound",
    channel: "sms",
    personId,
    applicationId,
    purpose: "reminder_24h",
    toAddress: to,
    fromAddress: HIRING_NUMBER,
    body: "test",
    status,
    provider: "quo",
    providerMessageId,
    triggeredByType: "system",
    sentAt: NOON,
    createdAt: NOON,
    updatedAt: NOON,
  });
  return id;
}

async function sentEmail(to: string, providerMessageId: string, status: "sent" | "delivered" = "sent") {
  const id = uuidv7();
  await db.insert(message).values({
    id,
    direction: "outbound",
    channel: "email",
    purpose: "submit_confirmation",
    toAddress: to,
    fromAddress: "hiring@example.test",
    subject: "test",
    body: "test",
    status,
    provider: "resend",
    providerMessageId,
    triggeredByType: "system",
    sentAt: NOON,
    createdAt: NOON,
    updatedAt: NOON,
  });
  return id;
}

async function row(id: string) {
  const [m] = await db.select().from(message).where(eq(message.id, id));
  return m!;
}

describe("Standard Webhooks verification", () => {
  const body = JSON.stringify({ type: "message.received" });

  it("accepts a valid signature inside the tolerance, with or without the whsec_ prefix", () => {
    const now = NOON;
    const headers = new Headers(signedHeaders(body, { now }));
    expect(verifyStandardWebhook({ secret: SECRET, headers: readSignatureHeaders(headers, "webhook"), body, now })).toEqual({ ok: true });

    const raw = "plain-text-secret";
    const rawHeaders = new Headers(signedHeaders(body, { now, secret: raw }));
    expect(verifyStandardWebhook({ secret: raw, headers: readSignatureHeaders(rawHeaders, "webhook"), body, now })).toEqual({ ok: true });

    // Several signatures in one header (key rotation): one valid entry is enough.
    const h = signedHeaders(body, { now });
    h["webhook-signature"] = `v1,AAAA v1a,ignored ${h["webhook-signature"]}`;
    expect(verifyStandardWebhook({ secret: SECRET, headers: readSignatureHeaders(new Headers(h), "webhook"), body, now })).toEqual({ ok: true });
  });

  it("rejects a bad signature, a tampered body and a different secret", () => {
    const now = NOON;
    const h = signedHeaders(body, { now });
    const headers = readSignatureHeaders(new Headers(h), "webhook");
    expect(verifyStandardWebhook({ secret: SECRET, headers, body: body + " ", now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStandardWebhook({ secret: "whsec_" + Buffer.from("other").toString("base64"), headers, body, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const forged = { ...headers, signature: "v1,bm90LWEtcmVhbC1zaWduYXR1cmU=" };
    expect(verifyStandardWebhook({ secret: SECRET, headers: forged, body, now })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a timestamp more than 5 minutes off, either way, and missing pieces", () => {
    const now = NOON;
    const old = signedHeaders(body, { now: new Date(now.getTime() - 6 * 60_000) });
    expect(verifyStandardWebhook({ secret: SECRET, headers: readSignatureHeaders(new Headers(old), "webhook"), body, now })).toEqual({
      ok: false,
      reason: "timestamp_out_of_range",
    });
    const future = signedHeaders(body, { now: new Date(now.getTime() + 6 * 60_000) });
    expect(verifyStandardWebhook({ secret: SECRET, headers: readSignatureHeaders(new Headers(future), "webhook"), body, now })).toEqual({
      ok: false,
      reason: "timestamp_out_of_range",
    });
    const edge = signedHeaders(body, { now: new Date(now.getTime() - 4 * 60_000) });
    expect(verifyStandardWebhook({ secret: SECRET, headers: readSignatureHeaders(new Headers(edge), "webhook"), body, now })).toEqual({ ok: true });

    const h = signedHeaders(body, { now });
    expect(verifyStandardWebhook({ secret: SECRET, headers: { ...readSignatureHeaders(new Headers(h), "webhook"), timestamp: "soon" }, body, now })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    });
    expect(verifyStandardWebhook({ secret: SECRET, headers: { id: null, timestamp: null, signature: null }, body, now })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(verifyStandardWebhook({ secret: undefined, headers: readSignatureHeaders(new Headers(h), "webhook"), body, now })).toEqual({
      ok: false,
      reason: "no_secret",
    });
  });
});

describe("Quo event parsing", () => {
  it("reads the likely field names and tolerates arrays and missing pieces", () => {
    const parsed = parseQuoEvent(
      {
        type: "message.received",
        data: { object: { id: "AC1", to: ["+17632922259"], from: "+16125550100", text: "hi there", phoneNumberId: "PN1" } },
      },
      NOON,
    );
    expect(parsed).toMatchObject({ type: "message.received", messageId: "AC1", to: HIRING_NUMBER, from: "+16125550100", body: "hi there", phoneNumberId: "PN1", direction: null });
    expect(parsed!.createdAt).toEqual(NOON);
    expect(parseQuoEvent({ data: {} }, NOON)).toBeNull();
    expect(parseQuoEvent("nope", NOON)).toBeNull();
    expect(parseQuoEvent({ type: "message.failed", data: { object: { id: "AC2", direction: "outgoing", error: { code: "30007", message: "blocked" } } } }, NOON)).toMatchObject({
      direction: "outgoing",
      errorCode: "30007",
      errorMessage: "blocked",
    });
  });

  it("recognises opt-out wording and the STOP carrier code", () => {
    expect(isOptOutError(null, "Recipient has opted out")).toBe(true);
    expect(isOptOutError("21610", null)).toBe(true);
    expect(isOptOutError("30003", "Unreachable destination handset")).toBe(false);
  });
});

describe("Quo events", () => {
  it("message.received from an applicant stores an unhandled inbound text on the thread", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const id = quoMessageId();
    const outcome = await handleQuoEvent(db, event("message.received", { id, direction: "incoming", from: mobile, to: HIRING_NUMBER, body: "Is the job still open?" }), { now: NOON });
    expect(outcome.kind).toBe("inbound");
    if (outcome.kind !== "inbound") return;
    expect(outcome.outcome.kind).toBe("unhandled");
    const [m] = await db.select().from(message).where(eq(message.providerMessageId, id));
    expect(m).toMatchObject({ direction: "inbound", status: "received", personId, applicationId, fromAddress: mobile, toAddress: HIRING_NUMBER, handledAt: null });

    // A redelivery of the same event changes nothing.
    const again = await handleQuoEvent(db, event("message.received", { id, direction: "incoming", from: mobile, to: HIRING_NUMBER, body: "Is the job still open?" }), { now: NOON });
    expect(again).toMatchObject({ kind: "inbound", outcome: { kind: "duplicate" } });
    expect(await db.select().from(message).where(eq(message.providerMessageId, id))).toHaveLength(1);
  });

  it("HELP by webhook gets the templated reply through the given providers", async () => {
    const mobile = nextMobile();
    const sink = createSinkProviders();
    const outcome = await handleQuoEvent(db, event("message.received", { id: quoMessageId(), from: mobile, to: HIRING_NUMBER, body: "HELP" }), { now: NOON, providers: sink });
    expect(outcome).toMatchObject({ kind: "inbound", outcome: { kind: "help" } });
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.message.to).toBe(mobile);
  });

  it("drops events for another Quo number before storing anything", async () => {
    const mobile = nextMobile();
    const outcome = await handleQuoEvent(
      db,
      event("message.received", { id: quoMessageId(), direction: "incoming", from: mobile, to: "+16125550199", body: "STOP", phoneNumberId: "PNother" }),
      { now: NOON },
    );
    expect(outcome).toEqual({ kind: "ignored", reason: "other_number" });
    expect(await db.select().from(message).where(eq(message.fromAddress, mobile))).toHaveLength(0);
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(0);
  });

  it("falls back to the E.164 when the payload carries no phone number id", async () => {
    const mobile = nextMobile();
    const payload = quoPayload("message.received", { id: quoMessageId(), from: mobile, to: HIRING_NUMBER, body: "hello" });
    delete (payload.data.object as QuoObject).phoneNumberId;
    const outcome = await handleQuoEvent(db, parseQuoEvent(payload, NOON)!, { now: NOON });
    expect(outcome).toMatchObject({ kind: "inbound", outcome: { kind: "unhandled" } });
  });

  it("message.delivered moves a sent text forward once, and never backwards", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const providerId = quoMessageId();
    const id = await sentText(personId, applicationId, mobile, providerId);
    const later = new Date(NOON.getTime() + 5_000);

    const first = await handleQuoEvent(db, event("message.delivered", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile, status: "delivered" }), { now: later });
    expect(first).toMatchObject({ kind: "status", messageId: id, status: "delivered", changed: true, suppressed: false });
    let m = await row(id);
    expect(m.status).toBe("delivered");
    expect(m.deliveredAt).toEqual(later);

    const redelivered = await handleQuoEvent(db, event("message.delivered", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile }), { now: new Date(later.getTime() + 1000) });
    expect(redelivered).toMatchObject({ kind: "status", changed: false });
    m = await row(id);
    expect(m.deliveredAt).toEqual(later);

    // A late failure after a delivery is ignored: the first terminal status wins.
    const lateFailure = await handleQuoEvent(db, event("message.failed", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile, errorCode: "30005" }), { now: later });
    expect(lateFailure).toMatchObject({ kind: "status", changed: false });
    expect((await row(id)).status).toBe("delivered");
  });

  it("message.failed with an opt-out error records carrier_blocked and a consent event, once", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const providerId = quoMessageId();
    const id = await sentText(personId, applicationId, mobile, providerId);

    const failed = event("message.failed", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile, errorCode: "21610", errorMessage: "Recipient has opted out" });
    const outcome = await handleQuoEvent(db, failed, { now: NOON });
    expect(outcome).toMatchObject({ kind: "status", messageId: id, status: "failed", changed: true, suppressed: true });
    const m = await row(id);
    expect(m.status).toBe("failed");
    expect(m.errorCode).toBe("21610");
    expect(m.failedAt).toEqual(NOON);
    const [s] = await db.select().from(suppression).where(and(eq(suppression.address, mobile), eq(suppression.channel, "sms")));
    expect(s).toMatchObject({ reason: "carrier_blocked", messageId: id, liftedAt: null });
    const consents = await db.select().from(consentEvent).where(eq(consentEvent.messageId, id));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ action: "opt_out", method: "keyword", personId, applicationId, employerId });

    const again = await handleQuoEvent(db, failed, { now: NOON });
    expect(again).toMatchObject({ kind: "status", changed: false, suppressed: false });
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(1);
    expect(await db.select().from(consentEvent).where(eq(consentEvent.messageId, id))).toHaveLength(1);
  });

  it("message.undelivered without an opt-out error marks the text undelivered and nothing else", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const providerId = quoMessageId();
    const id = await sentText(personId, applicationId, mobile, providerId);
    const outcome = await handleQuoEvent(db, event("message.undelivered", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile, errorCode: "30003" }), { now: NOON });
    expect(outcome).toMatchObject({ kind: "status", status: "undelivered", changed: true, suppressed: false });
    expect((await row(id)).errorCode).toBe("30003");
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(0);
  });

  it("an outgoing text with no matching row is a reply a staff member typed in the Quo app", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const providerId = quoMessageId();
    const typed = event("message.delivered", { id: providerId, direction: "outgoing", from: HIRING_NUMBER, to: mobile, body: "Yes, still open. Can you come Tuesday?", userId: "USstaff1" });
    const outcome = await handleQuoEvent(db, typed, { now: NOON });
    expect(outcome).toMatchObject({ kind: "staff_reply", created: true });
    if (outcome.kind !== "staff_reply") return;
    const m = await row(outcome.messageId);
    expect(m).toMatchObject({
      direction: "outbound",
      channel: "sms",
      personId,
      applicationId,
      toAddress: mobile,
      fromAddress: HIRING_NUMBER,
      body: "Yes, still open. Can you come Tuesday?",
      status: "delivered",
      provider: "quo",
      providerMessageId: providerId,
      templateId: null,
      triggeredByType: "staff",
      triggeredByUserId: null,
    });
    // A redelivery finds the row and takes the status path, which changes nothing.
    const again = await handleQuoEvent(db, typed, { now: NOON });
    expect(again).toMatchObject({ kind: "status", messageId: outcome.messageId, status: "delivered", changed: false });
    expect(await db.select().from(message).where(eq(message.providerMessageId, providerId))).toHaveLength(1);
  });

  it("ignores unknown event types and events without a message id", async () => {
    expect(await handleQuoEvent(db, event("call.completed", { id: quoMessageId(), from: HIRING_NUMBER, to: nextMobile() }), { now: NOON })).toEqual({ kind: "ignored", reason: "unknown_event" });
    const noId = event("message.delivered", { direction: "outgoing", from: HIRING_NUMBER, to: nextMobile() });
    expect(await handleQuoEvent(db, noId, { now: NOON })).toEqual({ kind: "ignored", reason: "no_message_id" });
    const noBody = event("message.delivered", { id: quoMessageId(), direction: "outgoing", from: HIRING_NUMBER, to: nextMobile() });
    expect(await handleQuoEvent(db, noBody, { now: NOON })).toMatchObject({ kind: "unmatched" });
  });
});

describe("Resend events", () => {
  function resendPayload(type: string, data: Record<string, unknown>) {
    return { type, created_at: NOON.toISOString(), data: { email_id: `re_${uuidv7()}`, from: "hiring@example.test", subject: "x", created_at: NOON.toISOString(), ...data } };
  }

  it("a hard bounce marks the email undelivered and suppresses the address", async () => {
    const to = `Bounce.${uuidv7()}@Example.test`;
    const emailId = `re_${uuidv7()}`;
    const id = await sentEmail(to, emailId);
    const payload = resendPayload("email.bounced", { email_id: emailId, to: [to], bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" } });
    const outcome = await handleResendEvent(db, parseResendEvent(payload, NOON)!, { now: NOON });
    expect(outcome).toMatchObject({ kind: "status", messageId: id, status: "undelivered", changed: true });
    const m = await row(id);
    expect(m.status).toBe("undelivered");
    expect(m.errorCode).toBe("bounce:Permanent:General");
    expect(m.failedAt).toEqual(NOON);
    const [s] = await db.select().from(suppression).where(and(eq(suppression.channel, "email"), eq(suppression.address, to.toLowerCase())));
    expect(s).toMatchObject({ reason: "email_hard_bounce", messageId: id, liftedAt: null });

    const again = await handleResendEvent(db, parseResendEvent(payload, NOON)!, { now: NOON });
    expect(again).toMatchObject({ changed: false });
    expect(await db.select().from(suppression).where(and(eq(suppression.channel, "email"), eq(suppression.address, to.toLowerCase())))).toHaveLength(1);
  });

  it("a transient bounce changes the status but adds no suppression", async () => {
    const to = `soft.${uuidv7()}@example.test`;
    const emailId = `re_${uuidv7()}`;
    const id = await sentEmail(to, emailId);
    const payload = resendPayload("email.bounced", { email_id: emailId, to: [to], bounce: { type: "Transient", subType: "MailboxFull" } });
    const outcome = await handleResendEvent(db, parseResendEvent(payload, NOON)!, { now: NOON });
    expect(outcome).toMatchObject({ status: "undelivered", changed: true, suppressed: [] });
    expect((await row(id)).status).toBe("undelivered");
    expect(await db.select().from(suppression).where(eq(suppression.address, to))).toHaveLength(0);
  });

  it("a complaint suppresses the address and leaves the delivery status alone", async () => {
    const to = `complaint.${uuidv7()}@example.test`;
    const emailId = `re_${uuidv7()}`;
    const id = await sentEmail(to, emailId, "delivered");
    const outcome = await handleResendEvent(db, parseResendEvent(resendPayload("email.complained", { email_id: emailId, to: [to] }), NOON)!, { now: NOON });
    expect(outcome).toMatchObject({ kind: "status", messageId: id, status: null, changed: false, suppressed: [to] });
    expect((await row(id)).status).toBe("delivered");
    const [s] = await db.select().from(suppression).where(and(eq(suppression.channel, "email"), eq(suppression.address, to)));
    expect(s!.reason).toBe("email_complaint");
  });

  it("delivery events only move forward, and unknown types are ignored", async () => {
    const to = `fwd.${uuidv7()}@example.test`;
    const emailId = `re_${uuidv7()}`;
    const id = await sentEmail(to, emailId);
    await handleResendEvent(db, parseResendEvent(resendPayload("email.delivered", { email_id: emailId, to: [to] }), NOON)!, { now: NOON });
    expect((await row(id)).status).toBe("delivered");
    const late = await handleResendEvent(db, parseResendEvent(resendPayload("email.sent", { email_id: emailId, to: [to] }), NOON)!, { now: NOON });
    expect(late).toMatchObject({ status: "sent", changed: false });
    expect((await row(id)).status).toBe("delivered");
    expect(await handleResendEvent(db, parseResendEvent(resendPayload("email.opened", { email_id: emailId, to: [to] }), NOON)!, { now: NOON })).toEqual({
      kind: "ignored",
      reason: "unknown_event",
    });
  });

  it("a hard bounce for an email Tidepool did not send still suppresses the address", async () => {
    const to = `other-app.${uuidv7()}@example.test`;
    const outcome = await handleResendEvent(
      db,
      parseResendEvent(resendPayload("email.bounced", { to: [to], bounce: { type: "Permanent", subType: "Suppressed" } }), NOON)!,
      { now: NOON },
    );
    expect(outcome).toMatchObject({ kind: "status", messageId: null, changed: false, suppressed: [to] });
    const [s] = await db.select().from(suppression).where(and(eq(suppression.channel, "email"), eq(suppression.address, to)));
    expect(s).toMatchObject({ reason: "email_hard_bounce", messageId: null });
  });
});

describe("route handlers", () => {
  const original = { quo: process.env.QUO_WEBHOOK_SECRET, resend: process.env.RESEND_WEBHOOK_SECRET };
  afterAll(() => {
    process.env.QUO_WEBHOOK_SECRET = original.quo;
    process.env.RESEND_WEBHOOK_SECRET = original.resend;
  });

  it("the Quo route answers 503 without a secret, 401 on a bad signature and 200 after a valid one", async () => {
    const body = JSON.stringify(quoPayload("message.received", { id: quoMessageId(), from: nextMobile(), to: HIRING_NUMBER, body: "hello from the route" }));
    delete process.env.QUO_WEBHOOK_SECRET;
    // No stored secret either (quo:setup's integration_secret row), and nothing cached.
    await db.delete(integrationSecret);
    resetQuoWebhookSecretCache();
    const noSecret = await quoPost(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: signedHeaders(body), body }));
    expect(noSecret.status).toBe(503);

    process.env.QUO_WEBHOOK_SECRET = SECRET;
    const bad = await quoPost(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: signedHeaders(body, { secret: "whsec_" + Buffer.from("wrong").toString("base64") }), body }));
    expect(bad.status).toBe(401);
    expect(await db.select().from(message).where(eq(message.body, "hello from the route"))).toHaveLength(0);

    const good = await quoPost(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: signedHeaders(body), body }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, outcome: "inbound" });
    expect(await db.select().from(message).where(eq(message.body, "hello from the route"))).toHaveLength(1);

    const unknown = JSON.stringify({ type: "call.ringing", data: { object: { id: "x" } } });
    const ignored = await quoPost(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: signedHeaders(unknown), body: unknown }));
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ok: true, outcome: "ignored" });

    const notJson = "not json at all";
    const junk = await quoPost(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: signedHeaders(notJson), body: notJson }));
    expect(junk.status).toBe(200);
  });

  it("the Resend route verifies svix headers and records a bounce", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const to = `route.${uuidv7()}@example.test`;
    const body = JSON.stringify({ type: "email.bounced", created_at: NOON.toISOString(), data: { email_id: `re_${uuidv7()}`, to: [to], bounce: { type: "Permanent", subType: "General" } } });
    const bad = await resendPost(new Request("http://localhost/api/webhooks/resend", { method: "POST", headers: signedHeaders(body, { prefix: "webhook" }), body }));
    expect(bad.status).toBe(401);
    const good = await resendPost(new Request("http://localhost/api/webhooks/resend", { method: "POST", headers: signedHeaders(body, { prefix: "svix" }), body }));
    expect(good.status).toBe(200);
    expect(await db.select().from(suppression).where(and(eq(suppression.channel, "email"), eq(suppression.address, to)))).toHaveLength(1);
  });
});
