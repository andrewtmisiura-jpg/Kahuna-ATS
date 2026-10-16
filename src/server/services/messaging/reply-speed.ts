import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "@/db";
import { message } from "@/db/schema";
import { classifyKeyword } from "./inbound";

// Text reply speed, a signal the owner expects to predict retention better than
// any answer (DATA_MODEL.md, "Text reply speed"). For each inbound text a person
// sends, the minutes since our most recent outbound message to them (text or
// email) that was actually sent before it and did not fail. Keyword texts (STOP,
// START, HELP and the other words the inbound service recognises) are ignored, and
// so is the automatic HELP reply we send back, so the clock is not reset by a
// message nobody chose to send. An inbound text with no earlier outbound message
// is ignored too. Email replies go to the hiring inbox, not Tidepool, so they
// cannot be counted. Per person, across their applications. The figure is the
// median, with the number of replies behind it.

export type ReplySpeed = {
  // Null when there are no replies to measure. Rounded to one decimal.
  medianMinutes: number | null;
  replies: number;
};

export type ReplyMessage = {
  direction: "inbound" | "outbound";
  channel: "sms" | "email";
  at: Date;
  body: string | null;
};

export const NO_REPLIES: ReplySpeed = { medianMinutes: null, replies: 0 };

// Outbound statuses that mean the message never reached the person.
const FAILED_STATUSES: Array<(typeof message.$inferSelect)["status"]> = ["failed", "undelivered"];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Pure: the reply times in one person's message history.
export function computeReplySpeed(messages: readonly ReplyMessage[]): ReplySpeed {
  // Time order; on a tie the inbound text sorts first, since it did not come after.
  const ordered = [...messages].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.direction === b.direction ? 0 : a.direction === "inbound" ? -1 : 1),
  );
  let lastOutbound: Date | null = null;
  const minutes: number[] = [];
  for (const m of ordered) {
    if (m.direction === "outbound") {
      lastOutbound = m.at;
      continue;
    }
    if (m.channel !== "sms") continue;
    if (classifyKeyword(m.body ?? "") !== null) continue;
    if (!lastOutbound) continue;
    minutes.push((m.at.getTime() - lastOutbound.getTime()) / 60_000);
  }
  const mid = median(minutes);
  return { medianMinutes: mid === null ? null : Math.round(mid * 10) / 10, replies: minutes.length };
}

// Outbound messages count from when they were sent; queued, suppressed and failed
// ones never reached the person. A text Quo accepted keeps its sent_at when the
// carrier later reports it failed or undelivered, so those are left out by status
// and failed_at. The automatic HELP reply (purpose help_reply) answers a keyword
// text that is itself ignored, so it is left out too. Inbound texts count from
// when they arrived.
export async function replySpeedByPerson(db: Db, personIds: readonly string[]): Promise<Map<string, ReplySpeed>> {
  const result = new Map<string, ReplySpeed>();
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      personId: message.personId,
      direction: message.direction,
      channel: message.channel,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
      body: message.body,
    })
    .from(message)
    .where(
      and(
        inArray(message.personId, ids),
        or(
          and(
            eq(message.direction, "outbound"),
            isNotNull(message.sentAt),
            isNull(message.failedAt),
            notInArray(message.status, FAILED_STATUSES),
            or(isNull(message.purpose), ne(message.purpose, "help_reply")),
          ),
          and(eq(message.direction, "inbound"), eq(message.channel, "sms")),
        ),
      ),
    );
  const byPerson = new Map<string, ReplyMessage[]>();
  for (const row of rows) {
    if (!row.personId) continue;
    const at = row.direction === "outbound" ? row.sentAt! : row.createdAt;
    const list = byPerson.get(row.personId) ?? [];
    list.push({ direction: row.direction, channel: row.channel, at, body: row.direction === "inbound" ? row.body : null });
    byPerson.set(row.personId, list);
  }
  for (const id of ids) result.set(id, computeReplySpeed(byPerson.get(id) ?? []));
  return result;
}

export async function replySpeedForPerson(db: Db, personId: string): Promise<ReplySpeed> {
  return (await replySpeedByPerson(db, [personId])).get(personId) ?? NO_REPLIES;
}

// "Median 12 min across 3 replies", "No replies yet".
export function describeReplySpeed(speed: ReplySpeed): string {
  if (speed.medianMinutes === null || speed.replies === 0) return "No replies yet";
  return `Median ${formatMinutes(speed.medianMinutes)} across ${speed.replies} ${speed.replies === 1 ? "reply" : "replies"}`;
}

export function formatMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
