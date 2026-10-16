import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, sql } from "@/db";
import { seedPhase1 } from "@/db/seed";
import { JOBS_TIME_BUDGET_MS, runCronPass } from "@/cron/pass";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { TEST_ADMIN_EMAIL } from "./helpers/fixtures";

// The order of the steps in one cron pass (src/cron/pass.ts), the two Phase 2 steps
// included: interview reminders after the application reminders and before sending,
// so one due now goes out in the same pass; jobs after the backup; the heartbeat last.
// Each step's service is wrapped to record that it ran, then does its real work, and
// can be made to throw.

const { recorded, wrap } = vi.hoisted(() => {
  const recorded = { calls: [] as string[], failing: new Set<string>(), jobOptions: [] as unknown[] };
  function wrap<A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      recorded.calls.push(name);
      if (recorded.failing.has(name)) throw new Error(`${name} broke on purpose`);
      return run(...args);
    };
  }
  return { recorded, wrap };
});

vi.mock("@/server/services/messaging/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/send")>();
  return { ...actual, reapStuckMessages: wrap("reap", actual.reapStuckMessages), sendDueMessages: wrap("send", actual.sendDueMessages) };
});
vi.mock("@/server/services/messaging/reminders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/reminders")>();
  return { ...actual, queueDueReminders: wrap("reminders", actual.queueDueReminders) };
});
vi.mock("@/server/services/messaging/interview-reminders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/interview-reminders")>();
  return { ...actual, queueInterviewReminders: wrap("interview_reminders", actual.queueInterviewReminders) };
});
vi.mock("@/server/services/messaging/inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/inbox")>();
  return { ...actual, alertUnhandledInbound: wrap("inbox", actual.alertUnhandledInbound) };
});
vi.mock("@/server/services/messaging/digest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/digest")>();
  return { ...actual, sendDailyDigest: wrap("digest", actual.sendDailyDigest) };
});
vi.mock("@/server/services/backup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/backup")>();
  return { ...actual, runNightlyBackupIfDue: wrap("backup", actual.runNightlyBackupIfDue) };
});
vi.mock("@/server/services/jobs/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/jobs/run")>();
  const runDueJobs: typeof actual.runDueJobs = (database, options) => {
    recorded.jobOptions.push(options);
    return actual.runDueJobs(database, options);
  };
  return { ...actual, runDueJobs: wrap("jobs", runDueJobs) };
});
vi.mock("@/server/services/health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/health")>();
  return { ...actual, writeHeartbeat: wrap("heartbeat", actual.writeHeartbeat) };
});

// 11:00pm CST on Feb 10, 2026, as in messaging-cron.test.ts: nothing another file queued is due.
const NOW = new Date("2026-02-11T05:00:00Z");

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
});

afterAll(async () => {
  await sql.end();
});

describe("cron pass steps", () => {
  it("run in order, with interview reminders before sending, jobs after the backup and the heartbeat last", async () => {
    recorded.calls.length = 0;
    recorded.jobOptions.length = 0;
    const report = await runCronPass(db, { now: NOW, providers: createSinkProviders(), env: {} });
    expect(report.failed).toEqual([]);
    expect(recorded.calls).toEqual(["reap", "reminders", "interview_reminders", "send", "inbox", "digest", "backup", "jobs", "heartbeat"]);
    // The counts belong to each step's own tests; here only that they report them.
    expect(report.interviewReminders).toMatchObject({ ok: true, value: { queued: expect.any(Number) } });
    expect(report.jobs).toMatchObject({
      ok: true,
      value: {
        claimed: expect.any(Number),
        succeeded: expect.any(Number),
        retried: expect.any(Number),
        dead: expect.any(Number),
        deferredByCap: expect.any(Number),
      },
    });
    expect(recorded.jobOptions).toEqual([expect.objectContaining({ now: NOW, timeBudgetMs: JOBS_TIME_BUDGET_MS })]);
    expect(JOBS_TIME_BUDGET_MS).toBe(120_000);
  });

  it("a Phase 2 step that throws fails the pass and is alerted, and every later step still runs", async () => {
    recorded.calls.length = 0;
    recorded.failing = new Set(["interview_reminders", "jobs"]);
    try {
      const sink = createSinkProviders();
      const report = await runCronPass(db, { now: NOW, providers: sink, env: {} });
      expect(report.failed).toEqual(["interview_reminders", "jobs"]);
      expect(report.interviewReminders).toMatchObject({ ok: false, error: expect.stringContaining("interview_reminders broke on purpose") });
      expect(report.send.ok && report.heartbeat.ok).toBe(true);
      expect(recorded.calls.at(-1)).toBe("heartbeat");
      const subjects = sink.sent.filter((s) => s.channel === "email").map((s) => s.message.subject);
      expect(subjects).toEqual(expect.arrayContaining([expect.stringContaining("Cron step interview_reminders failed"), expect.stringContaining("Cron step jobs failed")]));
    } finally {
      recorded.failing = new Set();
    }
  });
});
