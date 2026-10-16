import type { Db } from "@/db";

export type InterviewReminderSummary = { queued: number };

// The one-on-one reminder (PLAN.md, Phase 2): one one_on_one_reminder message for each
// scheduled interview coming up, by text when the send rules allow it and otherwise by
// email, with a dedupe key per interview like the 24-hour reminder's, so overlapping
// passes queue it once. The cron runs it right after the application reminders and
// before sending. Queues nothing until the templates build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the templates build fills in
export async function queueInterviewReminders(db: Db, now: Date = new Date()): Promise<InterviewReminderSummary> {
  return { queued: 0 };
}
