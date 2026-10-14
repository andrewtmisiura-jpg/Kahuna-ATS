import { and, asc, eq, gte, isNull, like, lt, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { env } from "@/config/env";
import type { Db } from "@/db";
import { application, employer, message } from "@/db/schema";
import { SYSTEM_ACTOR } from "../actor";
import { BACKUP_HEARTBEAT_NAME, readHeartbeat } from "../health";
import { notifyAdmin } from "../notify";
import { addDays, centralDate, centralInstant, centralParts } from "../time";
import { countUnhandledInbound } from "./inbox";
import type { Providers } from "./providers/types";
import { processMessages, queueMessage } from "./send";

// The 7am Central daily digest (PLAN.md, Stack; DATA_MODEL.md, "Alerts"): what
// happened since yesterday's 7am, the unhandled-text count and the newest
// backup's age, emailed to ALERT_EMAIL once a day (dedupe key digest:<date>).

export const DIGEST_HOUR_CENTRAL = 7;
export const DIGEST_DEDUPE_PREFIX = "digest:";
export const BACKUP_STALE_AFTER_MS = 36 * 3_600_000;

export type DigestCounts = {
  date: string;
  from: Date;
  to: Date;
  started: number;
  submitted: number;
  textsSent: number;
  textsDelivered: number;
  textsUndelivered: number;
  textsFailed: number;
  emailsBounced: number;
  unhandledTexts: number;
  alerts: { count: number; kinds: string[] };
  lastBackupAt: Date | null;
  backupAgeHours: number | null;
};

// The 24 hours ending at 7am Central on `date` (today by default).
export function digestWindow(now: Date): { date: string; from: Date; to: Date } {
  const date = centralDate(now);
  return { date, from: centralInstant(addDays(date, -1), DIGEST_HOUR_CENTRAL), to: centralInstant(date, DIGEST_HOUR_CENTRAL) };
}

export async function buildDigest(db: Db, now: Date = new Date()): Promise<DigestCounts> {
  const { date, from, to } = digestWindow(now);
  const count = async (where: ReturnType<typeof and>) => {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(message).where(where);
    return row?.count ?? 0;
  };
  const inWindow = (column: AnyPgColumn) => and(gte(column, from), lt(column, to));
  const outboundSms = and(eq(message.direction, "outbound"), eq(message.channel, "sms"));

  const [startedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(application)
    .where(and(isNull(application.deletedAt), gte(application.startedAt, from), lt(application.startedAt, to)));
  const [submittedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(application)
    .where(and(isNull(application.deletedAt), gte(application.submittedAt, from), lt(application.submittedAt, to)));

  const alertRows = await db
    .select({ key: message.dedupeKey })
    .from(message)
    .where(and(like(message.dedupeKey, "alert:%"), gte(message.createdAt, from), lt(message.createdAt, to)));
  const kinds = [...new Set(alertRows.map((row) => row.key?.split(":")[1] ?? "unknown"))].sort();

  const lastBackupAt = await readHeartbeat(db, BACKUP_HEARTBEAT_NAME);
  return {
    date,
    from,
    to,
    started: startedRow?.count ?? 0,
    submitted: submittedRow?.count ?? 0,
    textsSent: await count(and(outboundSms, inWindow(message.sentAt))),
    textsDelivered: await count(and(outboundSms, inWindow(message.deliveredAt))),
    textsUndelivered: await count(and(outboundSms, eq(message.status, "undelivered"), inWindow(message.failedAt))),
    textsFailed: await count(and(outboundSms, eq(message.status, "failed"), inWindow(message.failedAt))),
    emailsBounced: await count(
      and(eq(message.direction, "outbound"), eq(message.channel, "email"), eq(message.status, "undelivered"), inWindow(message.failedAt)),
    ),
    unhandledTexts: await countUnhandledInbound(db),
    alerts: { count: alertRows.length, kinds },
    lastBackupAt,
    backupAgeHours: lastBackupAt ? Math.round(((now.getTime() - lastBackupAt.getTime()) / 3_600_000) * 10) / 10 : null,
  };
}

export function renderDigest(d: DigestCounts): { subject: string; body: string } {
  const undeliveredShare = d.textsSent > 0 ? Math.round((d.textsUndelivered / d.textsSent) * 100) : 0;
  const carrierNote =
    d.textsSent >= 10 && undeliveredShare >= 20
      ? `\nWatch out: ${undeliveredShare}% of texts went undelivered. That can mean carriers are filtering the hiring number.`
      : "";
  const backup =
    d.lastBackupAt === null
      ? "never (no backup recorded yet)"
      : `${d.backupAgeHours} hours ago${d.backupAgeHours! > 36 ? " (older than 36 hours)" : ""}`;
  const body = [
    `Tidepool daily digest for ${d.date} (the 24 hours ending 7:00am Central).`,
    "",
    `Applications started: ${d.started}`,
    `Applications submitted: ${d.submitted}`,
    `Texts sent: ${d.textsSent}`,
    `Texts delivered: ${d.textsDelivered}`,
    `Texts undelivered: ${d.textsUndelivered}`,
    `Texts failed: ${d.textsFailed}`,
    `Emails bounced: ${d.emailsBounced}`,
    `Unhandled texts right now: ${d.unhandledTexts}`,
    `Alerts since yesterday: ${d.alerts.count}${d.alerts.kinds.length > 0 ? ` (${d.alerts.kinds.join(", ")})` : ""}`,
    `Last backup: ${backup}`,
    carrierNote,
  ]
    .join("\n")
    .trimEnd();
  return { subject: `Daily digest ${d.date}`, body };
}

export type DigestResult = { sent: boolean; messageId: string | null; reason?: "before_7am" | "already_sent" | "no_alert_email" | "no_employer" };

// Sends today's digest on the first pass at or after 7am Central; later passes
// find the dedupe key and do nothing.
export async function sendDailyDigest(db: Db, options: { now?: Date; providers?: Providers } = {}): Promise<DigestResult> {
  const now = options.now ?? new Date();
  if (centralParts(now).hour < DIGEST_HOUR_CENTRAL) return { sent: false, messageId: null, reason: "before_7am" };
  const to = env().ALERT_EMAIL;
  if (!to) {
    console.warn("[digest] ALERT_EMAIL not set; the daily digest is not sent");
    return { sent: false, messageId: null, reason: "no_alert_email" };
  }
  const [emp] = await db.select({ id: employer.id }).from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
  if (!emp) return { sent: false, messageId: null, reason: "no_employer" };

  const date = centralDate(now);
  const [already] = await db.select({ id: message.id }).from(message).where(eq(message.dedupeKey, `${DIGEST_DEDUPE_PREFIX}${date}`)).limit(1);
  if (already) return { sent: false, messageId: already.id, reason: "already_sent" };

  const counts = await buildDigest(db, now);
  const { subject, body } = renderDigest(counts);
  const result = await queueMessage(db, {
    employerId: emp.id,
    channel: "email",
    content: { subject: `[Tidepool] ${subject}`, body },
    toAddress: to,
    dedupeKey: `${DIGEST_DEDUPE_PREFIX}${date}`,
    triggeredBy: SYSTEM_ACTOR,
    now,
  });
  if (!result.created) return { sent: false, messageId: result.messageId, reason: "already_sent" };
  if (options.providers) await processMessages(db, [result.messageId], options.providers, now);

  if (counts.lastBackupAt && now.getTime() - counts.lastBackupAt.getTime() > BACKUP_STALE_AFTER_MS) {
    await notifyAdmin(db, "backup_stale", "Backup is older than 36 hours", `Last backup: ${counts.lastBackupAt.toISOString()}`, {
      providers: options.providers,
      now,
    });
  }
  return { sent: true, messageId: result.messageId };
}
