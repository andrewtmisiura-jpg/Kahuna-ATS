import { and, asc, eq, gte, inArray, isNotNull, isNull, like } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, interview, message, person, role } from "@/db/schema";
import { SYSTEM_ACTOR } from "../actor";
import { addDays, centralDate, centralInstant, nextSendWindowStart } from "../time";
import { queueMessage, SendError } from "./send";
import { chooseChannel, reachPerson } from "./staff-sends";
import { formatCentralMoment, interviewReminderKey, parseInterviewReminderKey } from "./template-text";

export type InterviewReminderSummary = { queued: number; canceled: number; skipped: number };

// The one-on-one reminder (PLAN.md, Phase 2): one one_on_one_reminder message for each
// scheduled interview coming up, by text when the person has a current opt-in and
// texting is on, otherwise by email. It is due at 5pm Central the day before; an
// interview booked 20 hours ahead or less gets it right away, and one under an hour
// away gets none. The dedupe key interview:<id>:<scheduled_at ISO> allows one reminder
// per booked time, so overlapping passes queue it once and a rescheduled interview gets
// a new one. A queued reminder whose interview was rescheduled, canceled, deleted or
// closed, or has already started, is canceled. The cron runs this right after the
// application reminders and before sending, so one due now goes out in the same pass.

export const REMINDER_HOUR = 17;
export const REMINDER_RIGHT_AWAY_WITHIN_MS = 20 * 3_600_000;
export const REMINDER_MIN_LEAD_MS = 3_600_000;

// When a reminder should go out, or null when it would reach them less than an hour
// before the interview. A text also waits for 9am to 8pm Central (send rule 3).
export function reminderDueAt(scheduledAt: Date, now: Date, channel: "sms" | "email"): Date | null {
  const lead = scheduledAt.getTime() - now.getTime();
  if (lead < REMINDER_MIN_LEAD_MS) return null;
  let due = now;
  if (lead > REMINDER_RIGHT_AWAY_WITHIN_MS) {
    const dayBefore = centralInstant(addDays(centralDate(scheduledAt), -1), REMINDER_HOUR);
    if (dayBefore.getTime() > now.getTime()) due = dayBefore;
  }
  if (channel === "sms") due = nextSendWindowStart(due);
  return scheduledAt.getTime() - due.getTime() >= REMINDER_MIN_LEAD_MS ? due : null;
}

export async function queueInterviewReminders(db: Db, now: Date = new Date()): Promise<InterviewReminderSummary> {
  const summary: InterviewReminderSummary = { queued: 0, canceled: await cancelStaleReminders(db, now), skipped: 0 };

  const upcoming = await db
    .select({ interview, app: application, who: person, employerId: role.employerId })
    .from(interview)
    .innerJoin(application, eq(application.id, interview.applicationId))
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(role, eq(role.id, application.roleId))
    .where(
      and(
        eq(interview.status, "scheduled"),
        isNotNull(interview.scheduledAt),
        isNull(interview.deletedAt),
        gte(interview.scheduledAt, new Date(now.getTime() + REMINDER_MIN_LEAD_MS)),
        eq(application.status, "open"),
        isNull(application.deletedAt),
        eq(person.doNotContact, false),
        isNull(person.deletedAt),
      ),
    )
    .orderBy(asc(interview.scheduledAt))
    .limit(200);
  if (upcoming.length === 0) return summary;

  const keys = upcoming.map((row) => interviewReminderKey(row.interview.id, row.interview.scheduledAt!));
  const existing = new Map(
    (
      await db
        .select({ key: message.dedupeKey, id: message.id, status: message.status, channel: message.channel })
        .from(message)
        .where(inArray(message.dedupeKey, keys))
    ).map((row) => [row.key, row]),
  );
  const employers = new Map<string, typeof employer.$inferSelect>();
  for (const row of await db.select().from(employer)) employers.set(row.id, row);

  for (const row of upcoming) {
    const scheduledAt = row.interview.scheduledAt!;
    const key = interviewReminderKey(row.interview.id, scheduledAt);
    const found = existing.get(key);
    if (found && found.status !== "canceled") continue;

    if (found) {
      // Moved back to a time it was booked for before: the key belongs to the reminder
      // canceled for that very time, so that one is queued again, on its own channel.
      const due = reminderDueAt(scheduledAt, now, found.channel);
      if (!due) continue;
      const revived = await db
        .update(message)
        .set({ status: "queued", sendAfter: due, errorCode: null, updatedAt: now })
        .where(and(eq(message.id, found.id), eq(message.status, "canceled")))
        .returning({ id: message.id });
      summary.queued += revived.length;
      continue;
    }

    // Text first; when quiet hours would hold a text until less than an hour ahead, email instead.
    const reach = await reachPerson(db, row.who, employers.get(row.employerId)!);
    const choice = chooseChannel(reach, "one_on_one_reminder");
    if (!choice.channel) {
      summary.skipped += 1;
      continue;
    }
    let channel = choice.channel;
    let due = reminderDueAt(scheduledAt, now, channel);
    if (!due && channel === "sms" && "address" in reach.email) {
      channel = "email";
      due = reminderDueAt(scheduledAt, now, channel);
    }
    if (!due) continue;

    try {
      const result = await queueMessage(db, {
        employerId: row.employerId,
        channel,
        personId: row.who.id,
        applicationId: row.app.id,
        content: { purpose: "one_on_one_reminder", vars: { interview_time: formatCentralMoment(scheduledAt) } },
        dedupeKey: key,
        triggeredBy: SYSTEM_ACTOR,
        sendAfter: due,
        now,
      });
      if (result.created) summary.queued += 1;
    } catch (error) {
      if (!(error instanceof SendError)) throw error;
      summary.skipped += 1;
    }
  }
  return summary;
}

// Cancels queued reminders that no longer fit their interview: moved to another time
// (the new time gets its own reminder), canceled, held or no-show, deleted, on a closed
// or deleted application, or already started.
async function cancelStaleReminders(db: Db, now: Date): Promise<number> {
  const queued = await db
    .select({ id: message.id, key: message.dedupeKey })
    .from(message)
    .where(and(eq(message.status, "queued"), eq(message.purpose, "one_on_one_reminder"), like(message.dedupeKey, "interview:%")));
  const reminders = queued.flatMap((row) => {
    const parsed = parseInterviewReminderKey(row.key);
    return parsed ? [{ id: row.id, ...parsed }] : [];
  });
  if (reminders.length === 0) return 0;

  const interviews = await db
    .select({
      id: interview.id,
      status: interview.status,
      scheduledAt: interview.scheduledAt,
      deletedAt: interview.deletedAt,
      appStatus: application.status,
      appDeletedAt: application.deletedAt,
    })
    .from(interview)
    .innerJoin(application, eq(application.id, interview.applicationId))
    .where(inArray(interview.id, [...new Set(reminders.map((r) => r.interviewId))]));
  const byId = new Map(interviews.map((row) => [row.id, row]));

  const stale: { id: string; reason: string }[] = [];
  for (const reminder of reminders) {
    const row = byId.get(reminder.interviewId);
    let reason: string | null = null;
    if (!row || row.deletedAt || row.appDeletedAt || row.appStatus !== "open") reason = "interview_canceled";
    else if (row.status !== "scheduled") reason = row.status === "canceled" ? "interview_canceled" : "interview_done";
    else if (row.scheduledAt?.getTime() !== reminder.scheduledAt.getTime()) reason = "interview_rescheduled";
    else if (reminder.scheduledAt.getTime() <= now.getTime()) reason = "interview_started";
    if (reason) stale.push({ id: reminder.id, reason });
  }

  let canceled = 0;
  for (const reason of new Set(stale.map((s) => s.reason))) {
    const ids = stale.filter((s) => s.reason === reason).map((s) => s.id);
    const rows = await db
      .update(message)
      .set({ status: "canceled", errorCode: reason, updatedAt: now })
      .where(and(inArray(message.id, ids), eq(message.status, "queued")))
      .returning({ id: message.id });
    canceled += rows.length;
  }
  return canceled;
}
