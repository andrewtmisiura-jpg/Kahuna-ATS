import { aliasedTable, and, asc, desc, eq, isNull, lte, notExists, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { env } from "@/config/env";
import type { Db } from "@/db";
import { employer, message, person } from "@/db/schema";
import { SYSTEM_ACTOR } from "../actor";
import { centralDate, centralParts, weekdaysBetween } from "../time";
import type { Providers } from "./providers/types";
import { processMessages, queueMessage } from "./send";

// The inbound inbox (PLAN.md, "Where I am still pushing back" 3, and the message
// table notes). Every inbound text that keyword handling did not settle stays
// unhandled until a person marks it. Each one is emailed to the hiring address
// at once and again when it has sat unhandled for two business days. The admin
// area calls listUnhandledInbound, countUnhandledInbound and markHandled: the
// list's attention strip, each list row, the profile and the digest all count
// with unhandledInboundWhere, and the profile's "Mark handled" is markHandled.

export const REALERT_AFTER_BUSINESS_DAYS = 2;
export const INBOX_ALERT_PREFIX = "inbox_alert:";
export const INBOX_REALERT_PREFIX = "inbox_realert:";

export type UnhandledInbound = {
  messageId: string;
  body: string | null;
  receivedAt: Date;
  fromAddress: string | null;
  personId: string | null;
  applicationId: string | null;
  firstName: string | null;
  lastName: string | null;
};

// The texts one application's profile shows: those filed to it, plus the person's
// texts filed to no application. The columns are parameters so a list query can
// correlate them with its own application row.
export type InboundScope = { applicationId: string | AnyColumn; personId: string | AnyColumn };

function scopeWhere(scope: InboundScope): SQL {
  return or(eq(message.applicationId, scope.applicationId), and(eq(message.personId, scope.personId), isNull(message.applicationId)))!;
}

// The one rule for "unhandled": an inbound text nobody has marked handled, and not
// stripped by the purge. With a scope, only that profile's texts.
export function unhandledInboundWhere(scope?: InboundScope): SQL {
  return and(eq(message.direction, "inbound"), isNull(message.handledAt), isNull(message.redactedAt), scope ? scopeWhere(scope) : undefined)!;
}

const unhandledWhere = unhandledInboundWhere();

export async function listUnhandledInbound(db: Db, options: { limit?: number } = {}): Promise<UnhandledInbound[]> {
  return db
    .select({
      messageId: message.id,
      body: message.body,
      receivedAt: message.createdAt,
      fromAddress: message.fromAddress,
      personId: message.personId,
      applicationId: message.applicationId,
      firstName: person.firstName,
      lastName: person.lastName,
    })
    .from(message)
    .leftJoin(person, eq(person.id, message.personId))
    .where(unhandledWhere)
    .orderBy(desc(message.createdAt))
    .limit(options.limit ?? 200);
}

// Every unhandled text, or with a scope only the ones one profile shows.
export async function countUnhandledInbound(db: Db, scope?: { applicationId: string; personId: string }): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(message).where(unhandledInboundWhere(scope));
  return row?.count ?? 0;
}

// The same count as a correlated subquery, for a query over application rows.
export function unhandledInboundCountSql(applicationId: AnyColumn, personId: AnyColumn): SQL<number> {
  return sql<number>`(select count(*)::int from ${message} where ${unhandledInboundWhere({ applicationId, personId })})`;
}

// Marks one inbound text handled; the profile's "Mark handled" button calls this.
// False when it was already handled or is not an inbound text.
export async function markHandled(db: Db, messageId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(message)
    .set({ handledAt: now, handledBy: userId, updatedAt: now })
    .where(and(eq(message.id, messageId), eq(message.direction, "inbound"), isNull(message.handledAt)))
    .returning({ id: message.id });
  return rows.length > 0;
}

export type InboxAlertSummary = { alerted: string[]; realerted: string[]; recipient: string | null };

// Emails the hiring address about each unhandled text once (dedupe key
// inbox_alert:<message id>) and once more after two business days
// (inbox_realert:<message id>). Idempotent across overlapping cron passes.
export async function alertUnhandledInbound(
  db: Db,
  options: { now?: Date; providers?: Providers } = {},
): Promise<InboxAlertSummary> {
  const now = options.now ?? new Date();
  const [emp] = await db.select().from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
  if (!emp) return { alerted: [], realerted: [], recipient: null };
  // hiring@ reads these; until the owner sets it, the alert address stands in so a text is never missed.
  const recipient = emp.replyToAddress ?? env().ALERT_EMAIL ?? null;
  if (!recipient) {
    console.warn("[inbox] no reply_to_address or ALERT_EMAIL set; unhandled texts are not being emailed");
    return { alerted: [], realerted: [], recipient: null };
  }

  const queued: string[] = [];
  const alerted: string[] = [];
  const realerted: string[] = [];

  const fresh = await unhandledWithoutAlert(db, INBOX_ALERT_PREFIX);
  for (const item of fresh) {
    const result = await queueMessage(db, {
      employerId: emp.id,
      channel: "email",
      content: renderInboxEmail(item, now, "new"),
      toAddress: recipient,
      dedupeKey: `${INBOX_ALERT_PREFIX}${item.messageId}`,
      triggeredBy: SYSTEM_ACTOR,
      now,
    });
    if (result.created) {
      queued.push(result.messageId);
      alerted.push(item.messageId);
    }
  }

  const cutoff = new Date(now.getTime() - 2 * 86_400_000);
  const stale = (await unhandledWithoutAlert(db, INBOX_REALERT_PREFIX, cutoff)).filter(
    (item) => businessDaysUnhandled(item.receivedAt, now) >= REALERT_AFTER_BUSINESS_DAYS,
  );
  for (const item of stale) {
    const result = await queueMessage(db, {
      employerId: emp.id,
      channel: "email",
      content: renderInboxEmail(item, now, "reminder"),
      toAddress: recipient,
      dedupeKey: `${INBOX_REALERT_PREFIX}${item.messageId}`,
      triggeredBy: SYSTEM_ACTOR,
      now,
    });
    if (result.created) {
      queued.push(result.messageId);
      realerted.push(item.messageId);
    }
  }

  if (queued.length > 0 && options.providers) await processMessages(db, queued, options.providers, now);
  return { alerted, realerted, recipient };
}

// Whole business days (weekdays) between the day a text arrived and today, Central.
export function businessDaysUnhandled(receivedAt: Date, now: Date): number {
  return weekdaysBetween(centralDate(receivedAt), centralDate(now));
}

async function unhandledWithoutAlert(db: Db, prefix: string, receivedBefore?: Date): Promise<UnhandledInbound[]> {
  const alert = aliasedTable(message, "alert");
  const alertRow = db
    .select({ one: sql`1` })
    .from(alert)
    .where(eq(alert.dedupeKey, sql`${prefix} || ${message.id}::text`));
  return db
    .select({
      messageId: message.id,
      body: message.body,
      receivedAt: message.createdAt,
      fromAddress: message.fromAddress,
      personId: message.personId,
      applicationId: message.applicationId,
      firstName: person.firstName,
      lastName: person.lastName,
    })
    .from(message)
    .leftJoin(person, eq(person.id, message.personId))
    .where(and(unhandledWhere, notExists(alertRow), receivedBefore ? lte(message.createdAt, receivedBefore) : undefined))
    .orderBy(asc(message.createdAt))
    .limit(200);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatCentral(instant: Date): string {
  const p = centralParts(instant);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "am" : "pm";
  return `${MONTHS[p.month - 1]} ${p.day}, ${hour12}:${String(p.minute).padStart(2, "0")}${ampm} Central`;
}

function describeSender(item: UnhandledInbound): string {
  const name = [item.firstName, item.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  const last4 = item.fromAddress?.slice(-4);
  return last4 ? `A number not on file (ending in ${last4})` : "An unknown number";
}

export function renderInboxEmail(item: UnhandledInbound, now: Date, kind: "new" | "reminder"): { subject: string; body: string } {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, "");
  const sender = describeSender(item);
  const link = item.applicationId ? `${base}/admin/applicants/${item.applicationId}` : `${base}/admin/applicants`;
  const text = (item.body ?? "").trim() || "(no text, maybe a picture)";
  const days = businessDaysUnhandled(item.receivedAt, now);
  const subject =
    kind === "new" ? `New text from ${sender}` : `Still unhandled: text from ${sender} (${days} business days)`;
  const body = [
    kind === "new"
      ? `${sender} texted the hiring number on ${formatCentral(item.receivedAt)}:`
      : `This text from ${sender} arrived ${formatCentral(item.receivedAt)} and nobody has marked it handled yet:`,
    "",
    `"${text}"`,
    "",
    item.applicationId ? `Open the profile: ${link}` : `Open the applicant list: ${link}`,
    "",
    "To answer, open the thread in the Quo app on the hiring number and type a reply. Then mark the text handled in Tidepool.",
    "If they are asking us to stop texting, tap \"They asked me to stop\" on the profile the same day.",
  ].join("\n");
  return { subject, body };
}
