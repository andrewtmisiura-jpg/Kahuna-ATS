import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, message, person } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { recordConsent, suppress } from "./consent";
import { recordInboundText, type InboundOutcome } from "./inbound";
import type { Providers } from "./providers/types";

// Provider webhooks (DATA_MODEL.md, send rule 7 and the message table notes).
// Both Quo and Resend sign deliveries the Standard Webhooks way: three headers
// (id, timestamp, signature) and an HMAC-SHA256 over "<id>.<timestamp>.<raw body>".
// Quo names them webhook-*, Resend (through svix) names them svix-*. The route
// handlers verify against the raw body, then hand the parsed event to the
// handlers below. Redeliveries are harmless: inbound inserts dedupe on
// provider_message_id and status updates only ever move forward.

// ---------------------------------------------------------------------------
// Signature verification

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type SignatureHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export type VerifyFailure = "no_secret" | "missing_headers" | "bad_timestamp" | "timestamp_out_of_range" | "bad_signature";
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

// Reads the three signature headers; `prefix` is "webhook" for Quo and "svix" for Resend.
export function readSignatureHeaders(headers: Headers, prefix: "webhook" | "svix"): SignatureHeaders {
  return {
    id: headers.get(`${prefix}-id`),
    timestamp: headers.get(`${prefix}-timestamp`),
    signature: headers.get(`${prefix}-signature`),
  };
}

// The secret may carry a "whsec_" prefix before a base64 key (svix style). Without
// the prefix the key could be the raw text or base64, so both readings are tried.
function secretKeys(secret: string): Buffer[] {
  const trimmed = secret.trim();
  if (trimmed.startsWith("whsec_")) return [Buffer.from(trimmed.slice("whsec_".length), "base64")];
  const keys = [Buffer.from(trimmed, "utf8")];
  if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length > 0) keys.push(decoded);
  }
  return keys;
}

function parseTimestampSeconds(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  // Tolerate milliseconds: anything past the year 5138 in seconds is really ms.
  return value > 99_999_999_999 ? Math.floor(value / 1000) : value;
}

export function verifyStandardWebhook(input: {
  secret: string | undefined;
  headers: SignatureHeaders;
  body: string;
  now?: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  if (!input.secret) return { ok: false, reason: "no_secret" };
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const seconds = parseTimestampSeconds(timestamp);
  if (seconds === null) return { ok: false, reason: "bad_timestamp" };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const signedContent = `${id}.${timestamp}.${input.body}`;
  const expected = secretKeys(input.secret).map((key) => createHmac("sha256", key).update(signedContent, "utf8").digest());
  // "v1,<base64>" entries separated by spaces; other versions (v1a) are skipped.
  for (const entry of signature.split(/\s+/)) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (expected.some((candidate) => candidate.length === given.length && timingSafeEqual(candidate, given))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

// ---------------------------------------------------------------------------
// Quo events

// Assumed Quo payload, UNVERIFIED against live Quo (it follows OpenPhone's v1
// message webhooks, which Quo inherited). The parser below reads each field from
// several likely names and never throws on a missing one.
//
//   {
//     "id": "EV...",                       event id (also in the webhook-id header)
//     "type": "message.received" | "message.delivered" | "message.failed" | "message.undelivered",
//     "createdAt": "2026-10-15T20:01:02.000Z",
//     "data": {
//       "object": {
//         "id": "AC...",                   message id; equals the send response's data.id for texts we sent
//         "object": "message",
//         "direction": "incoming" | "outgoing",
//         "from": "+17635550100",
//         "to": "+17632922259",            sometimes an array with one entry
//         "body": "the text",              older shapes: "text" or "content"
//         "status": "received" | "sent" | "delivered" | "failed" | "undelivered",
//         "phoneNumberId": "PN...",        the Quo number the event belongs to
//         "userId": "US...",               the Quo user who typed an outgoing message
//         "createdAt": "...",
//         "errorCode": "...",              failures only; name unverified
//         "errorMessage": "..."            failures only; name unverified
//       }
//     }
//   }

export const QUO_EVENT_TYPES = ["message.received", "message.delivered", "message.failed", "message.undelivered"] as const;
export type QuoEventType = (typeof QUO_EVENT_TYPES)[number];

export type QuoEvent = {
  type: string;
  eventId: string | null;
  messageId: string | null;
  direction: "incoming" | "outgoing" | null;
  from: string | null;
  to: string | null;
  body: string | null;
  status: string | null;
  phoneNumberId: string | null;
  createdAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
    return null;
  }
  const obj = asObject(value);
  if (obj) return firstString(obj.phoneNumber ?? obj.number ?? obj.address ?? obj.e164);
  return null;
}

function pick(obj: Json | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const found = firstString(obj[key]);
    if (found !== null && found !== "") return found;
  }
  return null;
}

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(/^\d+$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export function parseQuoEvent(payload: unknown, now: Date = new Date()): QuoEvent | null {
  const root = asObject(payload);
  if (!root) return null;
  const type = pick(root, ["type", "event", "eventType"]);
  if (!type) return null;
  const data = asObject(root.data);
  const obj = asObject(data?.object) ?? data ?? asObject(root.message) ?? asObject(root.object);
  const rawDirection = pick(obj, ["direction"])?.toLowerCase() ?? null;
  const direction =
    rawDirection === null
      ? null
      : /^(in|incoming|inbound|received)$/.test(rawDirection)
        ? "incoming"
        : /^(out|outgoing|outbound|sent)$/.test(rawDirection)
          ? "outgoing"
          : null;
  const error = asObject(obj?.error);
  return {
    type,
    eventId: pick(root, ["id", "eventId"]),
    messageId: pick(obj, ["id", "messageId"]),
    direction,
    from: pick(obj, ["from", "fromNumber", "sender"]),
    to: pick(obj, ["to", "toNumber", "recipient", "recipients"]),
    body: pick(obj, ["body", "text", "content"]),
    status: pick(obj, ["status"])?.toLowerCase() ?? null,
    phoneNumberId: pick(obj, ["phoneNumberId", "phone_number_id"]) ?? pick(data, ["phoneNumberId"]),
    createdAt: parseDate(pick(obj, ["createdAt", "created_at", "receivedAt"]) ?? pick(root, ["createdAt", "created_at"]), now),
    errorCode: pick(obj, ["errorCode", "error_code"]) ?? pick(error, ["code"]),
    errorMessage: pick(obj, ["errorMessage", "error_message", "failureReason"]) ?? pick(error, ["message"]),
  };
}

export type QuoOutcome =
  | { kind: "ignored"; reason: "unknown_event" | "no_message_id" | "other_number" | "no_counterparty" }
  | { kind: "inbound"; outcome: InboundOutcome }
  | { kind: "staff_reply"; messageId: string; created: boolean }
  | { kind: "status"; messageId: string; status: MessageStatus; changed: boolean; suppressed: boolean }
  | { kind: "unmatched"; providerMessageId: string };

type MessageStatus = (typeof message.$inferSelect)["status"];

// Callbacks arrive out of order: a status applies only when it ranks above the
// stored one, and the first terminal status wins.
const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  unknown: 1,
  suppressed: 1,
  canceled: 1,
  received: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
  undelivered: 3,
};

function statusesBelow(target: MessageStatus): MessageStatus[] {
  const rank = STATUS_RANK[target];
  return (Object.keys(STATUS_RANK) as MessageStatus[]).filter((status) => STATUS_RANK[status] < rank);
}

function statusForQuoEvent(type: string, status: string | null): MessageStatus {
  switch (type) {
    case "message.delivered":
      return "delivered";
    case "message.failed":
      return "failed";
    case "message.undelivered":
      return "undelivered";
    default:
      if (status === "delivered") return "delivered";
      if (status === "failed") return "failed";
      if (status === "undelivered") return "undelivered";
      return "sent";
  }
}

// An error that says the number opted out: the same wording test the send
// function's Quo provider uses, plus the carrier code Twilio-based stacks return
// for a STOP block. Quo's own codes are unverified.
export function isOptOutError(code: string | null, text: string | null): boolean {
  const haystack = `${code ?? ""} ${text ?? ""}`;
  return /opt.?out|opted.?out|unsubscrib|blocked|stop/i.test(haystack) || /\b21610\b/.test(haystack);
}

export async function handleQuoEvent(
  db: Db,
  event: QuoEvent,
  options: { providers?: Providers; now?: Date } = {},
): Promise<QuoOutcome> {
  const now = options.now ?? new Date();
  if (!(QUO_EVENT_TYPES as readonly string[]).includes(event.type)) return { kind: "ignored", reason: "unknown_event" };
  if (!event.messageId) return { kind: "ignored", reason: "no_message_id" };

  // Which side is ours. A message.received with no direction is incoming.
  const direction = event.direction ?? (event.type === "message.received" ? "incoming" : "outgoing");
  const ourNumber = direction === "incoming" ? event.to : event.from;
  const theirNumber = direction === "incoming" ? event.from : event.to;

  // Tidepool only handles the hiring number: anything for another Quo number is
  // dropped before anything is stored. Matched by phone number id, or by the
  // E.164 when a payload carries no id.
  const emp = await findEmployer(db, event.phoneNumberId, ourNumber);
  if (!emp) return { kind: "ignored", reason: "other_number" };
  if (!theirNumber) return { kind: "ignored", reason: "no_counterparty" };

  if (direction === "incoming") {
    if (event.type !== "message.received") return { kind: "ignored", reason: "unknown_event" };
    const outcome = await recordInboundText(db, {
      providerMessageId: event.messageId,
      from: theirNumber,
      to: emp.smsFromE164!,
      body: event.body ?? "",
      receivedAt: event.createdAt,
      providers: options.providers,
      now,
    });
    return { kind: "inbound", outcome };
  }

  // Outgoing: a text we sent through the API, or one a staff member typed in the Quo app.
  const [existing] = await db.select().from(message).where(eq(message.providerMessageId, event.messageId)).limit(1);
  const status = statusForQuoEvent(event.type, event.status);
  if (existing) {
    if (event.type === "message.received") return { kind: "status", messageId: existing.id, status, changed: false, suppressed: false };
    return applyStatus(db, existing, status, event, now);
  }

  if (event.body === null) return { kind: "unmatched", providerMessageId: event.messageId };
  const who = await personByMobile(db, theirNumber);
  const app = who ? await latestApplication(db, who.id) : null;
  const inserted = await db
    .insert(message)
    .values({
      id: uuidv7(),
      direction: "outbound",
      channel: "sms",
      personId: who?.id ?? null,
      applicationId: app?.id ?? null,
      toAddress: theirNumber,
      fromAddress: emp.smsFromE164!,
      body: event.body,
      status,
      provider: "quo",
      providerMessageId: event.messageId,
      errorCode: status === "failed" || status === "undelivered" ? (event.errorCode ?? event.errorMessage ?? null) : null,
      sentAt: event.createdAt,
      deliveredAt: status === "delivered" ? now : null,
      failedAt: status === "failed" || status === "undelivered" ? now : null,
      // A staff member in the Quo app: staff, with no Tidepool user to point at.
      triggeredByType: "staff",
      triggeredByUserId: null,
      createdAt: event.createdAt,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: message.providerMessageId })
    .returning({ id: message.id });
  if (inserted[0]) return { kind: "staff_reply", messageId: inserted[0].id, created: true };
  const [raced] = await db.select({ id: message.id }).from(message).where(eq(message.providerMessageId, event.messageId)).limit(1);
  return { kind: "staff_reply", messageId: raced!.id, created: false };
}

async function applyStatus(db: Db, row: typeof message.$inferSelect, status: MessageStatus, event: QuoEvent, now: Date): Promise<QuoOutcome> {
  const failed = status === "failed" || status === "undelivered";
  const errorCode = failed ? (event.errorCode ?? event.errorMessage ?? null) : null;
  const updated = await db
    .update(message)
    .set({
      status,
      errorCode: errorCode ?? row.errorCode,
      deliveredAt: status === "delivered" ? now : row.deliveredAt,
      failedAt: failed ? now : row.failedAt,
      updatedAt: now,
    })
    .where(and(eq(message.id, row.id), inArray(message.status, statusesBelow(status))))
    .returning({ id: message.id });
  const changed = updated.length > 0;

  // Send rule 8: a failure that points to an opt-out records carrier_blocked and a
  // consent event, with no staff step. Only on a real change, so a redelivery is harmless.
  let suppressed = false;
  if (changed && failed && row.channel === "sms" && row.toAddress && isOptOutError(event.errorCode, event.errorMessage)) {
    const address = row.toAddress;
    await db.transaction(async (tx) => {
      await suppress(tx, { channel: "sms", address, reason: "carrier_blocked", messageId: row.id, now });
      if (row.personId) {
        const emp = await employerForRow(tx, row);
        await recordConsent(tx, {
          personId: row.personId,
          applicationId: row.applicationId,
          employerId: emp?.id ?? null,
          channel: "sms",
          address,
          action: "opt_out",
          method: "keyword",
          messageId: row.id,
          occurredAt: now,
        });
      }
    });
    suppressed = true;
  }
  return { kind: "status", messageId: row.id, status, changed, suppressed };
}

async function findEmployer(db: Db, phoneNumberId: string | null, ourNumber: string | null) {
  const rows = await db.select().from(employer).where(isNull(employer.archivedAt));
  if (phoneNumberId) return rows.find((row) => row.smsQuoPhoneNumberId === phoneNumberId) ?? null;
  if (ourNumber) return rows.find((row) => row.smsFromE164 === ourNumber) ?? null;
  return null;
}

async function employerForRow(db: Db, row: typeof message.$inferSelect) {
  const rows = await db.select().from(employer).where(isNull(employer.archivedAt));
  return rows.find((e) => e.smsFromE164 === row.fromAddress) ?? rows[0] ?? null;
}

// The unshared person with that mobile, followed to the root of any merge (the
// same rule the inbound service applies).
async function personByMobile(db: Db, mobile: string) {
  const [row] = await db
    .select()
    .from(person)
    .where(and(eq(person.mobileE164, mobile), eq(person.sharedMobile, false), isNull(person.deletedAt)));
  if (!row) return null;
  let current = row;
  for (let hops = 0; current.mergedIntoPersonId && hops < 10; hops++) {
    const [root] = await db.select().from(person).where(eq(person.id, current.mergedIntoPersonId));
    if (!root) break;
    current = root;
  }
  return current;
}

async function latestApplication(db: Db, personId: string) {
  const [row] = await db
    .select()
    .from(application)
    .where(and(eq(application.personId, personId), isNull(application.deletedAt)))
    .orderBy(desc(application.createdAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Resend events

// Resend's webhook payload (svix-signed), per Resend's docs; the bounce and
// failure objects are read tolerantly:
//
//   {
//     "type": "email.sent" | "email.delivered" | "email.delivery_delayed" | "email.bounced"
//           | "email.complained" | "email.failed" | "email.opened" | "email.clicked",
//     "created_at": "2026-10-15T20:01:02.000Z",
//     "data": {
//       "email_id": "...",                 the id the send call returned
//       "from": "...", "to": ["a@b.c"], "subject": "...", "created_at": "...",
//       "bounce": { "type": "Permanent" | "Transient" | "Undetermined", "subType": "...", "message": "..." },
//       "failed": { "reason": "..." }
//     }
//   }

export type ResendEvent = {
  type: string;
  emailId: string | null;
  to: string[];
  bounceType: string | null;
  bounceSubType: string | null;
  bounceMessage: string | null;
  failedReason: string | null;
  createdAt: Date;
};

export function parseResendEvent(payload: unknown, now: Date = new Date()): ResendEvent | null {
  const root = asObject(payload);
  if (!root) return null;
  const type = pick(root, ["type"]);
  if (!type) return null;
  const data = asObject(root.data);
  const bounce = asObject(data?.bounce);
  const failed = asObject(data?.failed);
  const rawTo = data?.to;
  const to = (Array.isArray(rawTo) ? rawTo : [rawTo]).filter((v): v is string => typeof v === "string" && v.includes("@"));
  return {
    type,
    emailId: pick(data, ["email_id", "emailId", "id"]),
    to,
    bounceType: pick(bounce, ["type"]),
    bounceSubType: pick(bounce, ["subType", "sub_type"]),
    bounceMessage: pick(bounce, ["message"]),
    failedReason: pick(failed, ["reason"]),
    createdAt: parseDate(pick(root, ["created_at", "createdAt"]), now),
  };
}

export type ResendOutcome =
  | { kind: "ignored"; reason: "unknown_event" | "no_email_id" }
  | { kind: "status"; messageId: string | null; status: MessageStatus | null; changed: boolean; suppressed: string[] };

// A hard bounce is anything Resend does not call transient or undetermined.
export function isHardBounce(bounceType: string | null): boolean {
  return !/^(transient|undetermined)$/i.test(bounceType ?? "");
}

export async function handleResendEvent(db: Db, event: ResendEvent, options: { now?: Date } = {}): Promise<ResendOutcome> {
  const now = options.now ?? new Date();
  let status: MessageStatus | null = null;
  let errorCode: string | null = null;
  let suppressReason: "email_hard_bounce" | "email_complaint" | null = null;
  switch (event.type) {
    case "email.sent":
      status = "sent";
      break;
    case "email.delivered":
      status = "delivered";
      break;
    case "email.bounced":
      status = "undelivered";
      errorCode = ["bounce", event.bounceType, event.bounceSubType].filter(Boolean).join(":").slice(0, 200);
      if (isHardBounce(event.bounceType)) suppressReason = "email_hard_bounce";
      break;
    case "email.failed":
      status = "failed";
      errorCode = `failed:${event.failedReason ?? "unknown"}`.slice(0, 200);
      break;
    case "email.complained":
      suppressReason = "email_complaint";
      break;
    case "email.delivery_delayed":
      return { kind: "ignored", reason: "unknown_event" };
    default:
      return { kind: "ignored", reason: "unknown_event" };
  }
  if (!event.emailId && status) return { kind: "ignored", reason: "no_email_id" };

  const [row] = event.emailId
    ? await db.select().from(message).where(eq(message.providerMessageId, event.emailId)).limit(1)
    : [undefined];

  let changed = false;
  if (row && status) {
    const failed = status === "failed" || status === "undelivered";
    const updated = await db
      .update(message)
      .set({
        status,
        errorCode: errorCode ?? row.errorCode,
        deliveredAt: status === "delivered" ? now : row.deliveredAt,
        failedAt: failed ? now : row.failedAt,
        updatedAt: now,
      })
      .where(and(eq(message.id, row.id), inArray(message.status, statusesBelow(status))))
      .returning({ id: message.id });
    changed = updated.length > 0;
  }

  // The webhook covers the whole Resend account, so a hard bounce or complaint
  // suppresses the address even when the email was not one of ours: the
  // suppression list is global on purpose and a dead address stays dead.
  const suppressed: string[] = [];
  if (suppressReason) {
    const addresses = new Set<string>(event.to);
    if (row?.toAddress) addresses.add(row.toAddress);
    for (const address of addresses) {
      await suppress(db, { channel: "email", address, reason: suppressReason, messageId: row?.id ?? null, now });
      suppressed.push(address);
    }
  }
  return { kind: "status", messageId: row?.id ?? null, status, changed, suppressed };
}
