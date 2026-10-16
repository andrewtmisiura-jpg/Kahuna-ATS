import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { cronHeartbeat, employer, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { describePass, runCronPass } from "@/cron/pass";
import { CRON_HEARTBEAT_NAME, readHeartbeat } from "@/server/services/health";
import { createSinkProviders, ProviderError } from "@/server/services/messaging/providers";
import { queueMessage } from "@/server/services/messaging/send";
import { SYSTEM_ACTOR } from "@/server/services/actor";
import { createApplication, createPerson, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// 11:00pm CST on Feb 10, 2026: after the digest hour, after 3am, and in the past,
// so nothing another test file queued "now" is due.
const NOW = new Date("2026-02-11T05:00:00Z");

let snow: SnowFixture;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
});

afterAll(async () => {
  await sql.end();
});

describe("one cron pass", () => {
  it("runs every step, writes the heartbeat and reports what it did", async () => {
    await db.delete(cronHeartbeat).where(eq(cronHeartbeat.name, CRON_HEARTBEAT_NAME));
    const sink = createSinkProviders();
    const report = await runCronPass(db, { now: NOW, providers: sink, env: {} });
    expect(report.failed).toEqual([]);
    expect(
      report.reap.ok &&
        report.reminders.ok &&
        report.interviewReminders.ok &&
        report.send.ok &&
        report.inbox.ok &&
        report.digest.ok &&
        report.backup.ok &&
        report.jobs.ok &&
        report.heartbeat.ok,
    ).toBe(true);
    if (report.digest.ok) expect(report.digest.value.reason === "already_sent" || report.digest.value.sent).toBe(true);
    if (report.backup.ok) expect(report.backup.value).toEqual({ kind: "skipped", reason: "r2_not_configured" });
    const beat = await readHeartbeat(db, CRON_HEARTBEAT_NAME);
    expect(beat).not.toBeNull();
    expect(beat!.getTime()).toBeGreaterThanOrEqual(report.startedAt.getTime());
    expect(describePass(report)).toMatch(/send sent=\d+ failed=\d+/);
    expect(describePass(report)).toContain("backup r2_not_configured");
    expect(describePass(report)).toMatch(/interview reminders queued=\d+/);
    expect(describePass(report)).toMatch(/jobs claimed=\d+ succeeded=\d+ retried=\d+ dead=\d+ deferred=\d+/);
  });

  it("two passes at the same moment send a queued message once and both finish", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile, firstName: "Cron" });
    const { applicationId } = await createApplication(db, snow, personId);
    const { messageId } = await queueMessage(db, {
      employerId,
      channel: "email",
      applicationId,
      content: { purpose: "submit_confirmation" },
      dedupeKey: `cron-test:${applicationId}`,
      triggeredBy: SYSTEM_ACTOR,
      now: NOW,
    });
    const sinkA = createSinkProviders();
    const sinkB = createSinkProviders();
    const [a, b] = await Promise.all([runCronPass(db, { now: NOW, providers: sinkA, env: {} }), runCronPass(db, { now: NOW, providers: sinkB, env: {} })]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    const sends = [...sinkA.sent, ...sinkB.sent].filter((s) => s.message.messageId === messageId);
    expect(sends).toHaveLength(1);
    const [row] = await db.select().from(message).where(eq(message.id, messageId));
    expect(row!.status).toBe("sent");
  });

  it("a failed send alerts the admin once an hour and the pass still completes", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile, firstName: "Fail" });
    const { applicationId } = await createApplication(db, snow, personId);
    const { messageId } = await queueMessage(db, {
      employerId,
      channel: "email",
      applicationId,
      content: { purpose: "submit_confirmation" },
      dedupeKey: `cron-fail:${applicationId}`,
      triggeredBy: SYSTEM_ACTOR,
      now: NOW,
    });
    const sink = createSinkProviders();
    sink.failures.push(new ProviderError("rejected", "Resend 422: bad address"));
    const report = await runCronPass(db, { now: NOW, providers: sink, env: {} });
    expect(report.failed).toEqual([]);
    expect(report.send.ok && report.send.value.failed).toContain(messageId);
    const alert = sink.sent.find((s) => s.channel === "email" && s.message.subject.includes("failed to send"));
    expect(alert?.message.to).toBe("alerts@example.test");
    expect(alert?.message.body).toContain(messageId);
    expect(alert?.message.body).not.toContain(mobile);
  });

  it("a step that throws is reported and alerted without stopping the heartbeat", async () => {
    // A provider whose email send throws something that is not a ProviderError still
    // ends as a failed send; a broken database handle is what makes a step throw.
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") throw new Error("database went away");
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const sink = createSinkProviders();
    const report = await runCronPass(broken, { now: NOW, providers: sink, env: {} });
    expect(report.failed.length).toBeGreaterThan(0);
    expect(report.heartbeat.ok).toBe(true);
    expect(describePass(report)).toContain("FAILED:");
    // The employer row is intact for the next test file.
    expect((await db.select().from(employer).where(eq(employer.id, employerId)))[0]).toBeDefined();
  });
});
