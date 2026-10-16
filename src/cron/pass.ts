import type { Db } from "@/db";
import { runNightlyBackupIfDue, type BackupEnv, type BackupResult, type Uploader } from "@/server/services/backup";
import { CRON_HEARTBEAT_NAME, writeHeartbeat } from "@/server/services/health";
import { runDueJobs, type JobsSummary } from "@/server/services/jobs/run";
import { sendDailyDigest, type DigestResult } from "@/server/services/messaging/digest";
import { alertUnhandledInbound, type InboxAlertSummary } from "@/server/services/messaging/inbox";
import { queueInterviewReminders, type InterviewReminderSummary } from "@/server/services/messaging/interview-reminders";
import type { Providers } from "@/server/services/messaging/providers/types";
import { queueDueReminders, type ReminderSummary } from "@/server/services/messaging/reminders";
import { reapStuckMessages, sendDueMessages, type SendSummary } from "@/server/services/messaging/send";
import { notifyAdmin } from "@/server/services/notify";

// One cron pass (DATA_MODEL.md, "The cron service"), run every 5 minutes by
// Railway. Each step is wrapped so one failure never stops the others; a failure
// goes through notifyAdmin and marks the pass failed. Every step is idempotent
// across overlapping passes: the sender and the job runner claim rows with SKIP
// LOCKED, both kinds of reminder, inbox alerts and the digest carry dedupe keys,
// the backup claims a row, and the heartbeat is an upsert that never moves backwards.

// Scoring jobs get two of the five minutes between passes, so a long batch never
// runs into the next pass.
export const JOBS_TIME_BUDGET_MS = 120_000;

export type PassOptions = {
  now?: Date;
  providers: Providers;
  env?: BackupEnv;
  upload?: Uploader;
};

export type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type PassReport = {
  startedAt: Date;
  finishedAt: Date;
  failed: string[];
  reap: StepResult<{ unknown: number; requeued: number }>;
  reminders: StepResult<ReminderSummary>;
  interviewReminders: StepResult<InterviewReminderSummary>;
  send: StepResult<SendSummary>;
  inbox: StepResult<InboxAlertSummary>;
  digest: StepResult<DigestResult>;
  backup: StepResult<BackupResult>;
  jobs: StepResult<JobsSummary>;
  heartbeat: StepResult<Date>;
};

export async function runCronPass(db: Db, options: PassOptions): Promise<PassReport> {
  const startedAt = options.now ?? new Date();
  const { providers } = options;
  const failed: string[] = [];

  const step = async <T>(name: string, run: () => Promise<T>): Promise<StepResult<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      failed.push(name);
      console.error(`[cron] ${name} failed`, error);
      await notifyAdmin(db, `cron_${name}`, `Cron step ${name} failed`, String(error).slice(0, 2000), { providers, now: startedAt });
      return { ok: false, error: String(error) };
    }
  };

  const reap = await step("reap", () => reapStuckMessages(db, startedAt));
  if (reap.ok && reap.value.unknown > 0) {
    await notifyAdmin(db, "send_unknown", `${reap.value.unknown} text(s) stuck in sending marked unknown`, "Check the profiles; nothing is resent automatically.", {
      providers,
      now: startedAt,
    });
  }

  // Reminders first, so one due inside the send window goes out in this pass.
  const reminders = await step("reminders", () => queueDueReminders(db, startedAt));
  const interviewReminders = await step("interview_reminders", () => queueInterviewReminders(db, startedAt));

  const send = await step("send", () => sendDueMessages(db, providers, { now: startedAt }));
  if (send.ok) {
    const s = send.value;
    if (s.failed.length > 0) {
      await notifyAdmin(db, "send_failed", `${s.failed.length} message(s) failed to send`, `Message ids: ${s.failed.join(", ")}`, { providers, now: startedAt });
    }
    if (s.capReached) {
      await notifyAdmin(db, "daily_cap", "Daily send cap reached", "Remaining messages are queued for 9am tomorrow. Raise the cap in Settings > Texting if this is expected.", {
        providers,
        now: startedAt,
      });
    }
    if (s.balanceEmpty) {
      await notifyAdmin(db, "quo_balance", "Quo balance is empty", "Texts are falling back to email until the balance is topped up (turn on auto-recharge in Quo).", {
        providers,
        now: startedAt,
      });
    }
  }

  const inbox = await step("inbox", () => alertUnhandledInbound(db, { now: startedAt, providers }));
  const digest = await step("digest", () => sendDailyDigest(db, { now: startedAt, providers }));
  const backup = await step("backup", () => runNightlyBackupIfDue(db, { now: startedAt, env: options.env, upload: options.upload, providers }));
  // A refused backup (pg_dump older than the server) already sent its own alert; it still fails the pass.
  if (backup.ok && backup.value.kind === "refused") failed.push("backup");
  // Scoring and re-scoring, one job at a time, inside the time budget.
  const jobs = await step("jobs", () => runDueJobs(db, { now: startedAt, providers, timeBudgetMs: JOBS_TIME_BUDGET_MS }));

  const finishedAt = new Date();
  const heartbeat = await step("heartbeat", async () => {
    await writeHeartbeat(db, CRON_HEARTBEAT_NAME, finishedAt);
    return finishedAt;
  });

  return { startedAt, finishedAt, failed, reap, reminders, interviewReminders, send, inbox, digest, backup, jobs, heartbeat };
}

export function describePass(report: PassReport): string {
  const parts: string[] = [];
  if (report.reap.ok) parts.push(`reap unknown=${report.reap.value.unknown} requeued=${report.reap.value.requeued}`);
  if (report.reminders.ok) parts.push(`reminders queued=${report.reminders.value.queued.length} skipped=${report.reminders.value.skipped.length}`);
  if (report.interviewReminders.ok) parts.push(`interview reminders queued=${report.interviewReminders.value.queued}`);
  if (report.send.ok) {
    const s = report.send.value;
    parts.push(`send sent=${s.sent.length} failed=${s.failed.length} deferred=${s.deferred.length} suppressed=${s.suppressed.length}`);
  }
  if (report.inbox.ok) parts.push(`inbox alerted=${report.inbox.value.alerted.length} realerted=${report.inbox.value.realerted.length}`);
  if (report.digest.ok) parts.push(`digest ${report.digest.value.sent ? "sent" : (report.digest.value.reason ?? "skipped")}`);
  if (report.backup.ok) {
    const b = report.backup.value;
    parts.push(`backup ${b.kind === "done" ? b.key : b.kind === "refused" ? `refused (${b.reason}: pg_dump ${b.pgDumpMajor}, server ${b.serverMajor})` : b.reason}`);
  }
  if (report.jobs.ok) {
    const j = report.jobs.value;
    parts.push(`jobs claimed=${j.claimed} succeeded=${j.succeeded} retried=${j.retried} dead=${j.dead} deferred=${j.deferredByCap}`);
  }
  if (report.failed.length > 0) parts.push(`FAILED: ${report.failed.join(", ")}`);
  return parts.join("; ");
}
