import { aliasedTable, and, asc, eq, gt, isNull, lte, notExists, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, message, person, role } from "@/db/schema";
import { SYSTEM_ACTOR } from "../actor";
import { nextSendWindowStart } from "../time";
import { isOptedIn, latestConsent } from "./consent";
import { queueMessage, SendError } from "./send";

// The one 24-hour reminder (PLAN.md, "What a snow applicant experiences";
// DATA_MODEL.md, "The cron service"). An application started 24 hours ago and
// not submitted, closed, deleted or do-not-contact gets exactly one reminder,
// by text when the number has a current opt-in and texting is on, else by
// email. The dedupe key reminder_24h:<application id> makes a second one
// impossible, whatever the cron does.

export const REMINDER_AFTER_MS = 24 * 3_600_000;
// Applications older than this never get a reminder, so a long cron outage does
// not wake up a week of old starts at once.
export const REMINDER_LOOKBACK_MS = 7 * 86_400_000;
export const REMINDER_DEDUPE_PREFIX = "reminder_24h:";

export type ReminderSummary = { queued: { applicationId: string; messageId: string; channel: "sms" | "email" }[]; skipped: { applicationId: string; reason: string }[] };

export async function queueDueReminders(db: Db, now: Date = new Date()): Promise<ReminderSummary> {
  const summary: ReminderSummary = { queued: [], skipped: [] };
  const existing = aliasedTable(message, "existing");
  const due = await db
    .select({
      applicationId: application.id,
      personId: person.id,
      mobile: person.mobileE164,
      email: person.email,
      employerId: role.employerId,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(role, eq(role.id, application.roleId))
    .where(
      and(
        isNull(application.submittedAt),
        eq(application.status, "open"),
        isNull(application.deletedAt),
        lte(application.startedAt, new Date(now.getTime() - REMINDER_AFTER_MS)),
        gt(application.startedAt, new Date(now.getTime() - REMINDER_LOOKBACK_MS)),
        eq(person.doNotContact, false),
        isNull(person.deletedAt),
        isNull(person.mergedIntoPersonId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(existing)
            .where(eq(existing.dedupeKey, sql`${REMINDER_DEDUPE_PREFIX} || ${application.id}::text`)),
        ),
      ),
    )
    .orderBy(asc(application.startedAt))
    .limit(200);
  if (due.length === 0) return summary;

  const employers = new Map<string, typeof employer.$inferSelect>();
  for (const row of await db.select().from(employer)) employers.set(row.id, row);

  // The reminder waits for 9am to 8pm Central on either channel.
  const sendAfter = nextSendWindowStart(now);
  for (const item of due) {
    const emp = employers.get(item.employerId);
    const textable = Boolean(emp?.smsEnabled && item.mobile && isOptedIn(await latestConsent(db, item.mobile!, item.employerId)));
    const channel: "sms" | "email" = textable ? "sms" : "email";
    try {
      const result = await queueMessage(db, {
        employerId: item.employerId,
        channel,
        personId: item.personId,
        applicationId: item.applicationId,
        content: { purpose: "reminder_24h" },
        dedupeKey: `${REMINDER_DEDUPE_PREFIX}${item.applicationId}`,
        triggeredBy: SYSTEM_ACTOR,
        sendAfter,
        now,
      });
      if (result.created) summary.queued.push({ applicationId: item.applicationId, messageId: result.messageId, channel });
    } catch (error) {
      if (error instanceof SendError) {
        summary.skipped.push({ applicationId: item.applicationId, reason: error.code });
        continue;
      }
      throw error;
    }
  }
  return summary;
}
