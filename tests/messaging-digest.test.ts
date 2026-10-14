import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, cronHeartbeat, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { BACKUP_HEARTBEAT_NAME, writeHeartbeat } from "@/server/services/health";
import { buildDigest, DIGEST_DEDUPE_PREFIX, digestWindow, renderDigest, sendDailyDigest } from "@/server/services/messaging/digest";
import { countUnhandledInbound } from "@/server/services/messaging/inbox";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { createApplication, createPerson, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// A window in the past (Feb 2026, standard time) so rows other test files write
// "now" never land in it: the 24 hours ending 7:00am CST on Feb 10, 2026.
const NOW = new Date("2026-02-10T13:30:00Z");
const IN_WINDOW = new Date("2026-02-09T20:00:00Z");
const BEFORE_WINDOW = new Date("2026-02-09T12:00:00Z");

let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

async function appStarted(at: Date, submittedAt: Date | null = null) {
  const personId = await createPerson(db, { mobileE164: nextMobile() });
  const { applicationId } = await createApplication(db, snow, personId);
  await db.update(application).set({ startedAt: at, lastActivityAt: at, submittedAt }).where(eq(application.id, applicationId));
  return { personId, applicationId };
}

async function outbound(values: Partial<typeof message.$inferInsert> & { channel: "sms" | "email"; status: typeof message.$inferInsert.status }) {
  await db.insert(message).values({
    id: uuidv7(),
    direction: "outbound",
    toAddress: values.channel === "sms" ? nextMobile() : `digest-${uuidv7()}@example.test`,
    fromAddress: "+17632922259",
    body: "digest fixture",
    provider: "sink",
    triggeredByType: "system",
    createdAt: IN_WINDOW,
    updatedAt: IN_WINDOW,
    ...values,
  });
}

describe("daily digest", () => {
  it("computes the window as the 24 hours ending 7am Central", () => {
    const w = digestWindow(NOW);
    expect(w.date).toBe("2026-02-10");
    expect(w.from.toISOString()).toBe("2026-02-09T13:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-02-10T13:00:00.000Z");
  });

  it("counts starts, submits, texts by outcome, bounced emails, alerts and the backup age", async () => {
    const before = await buildDigest(db, NOW);

    await appStarted(IN_WINDOW);
    await appStarted(IN_WINDOW, new Date(IN_WINDOW.getTime() + 60_000));
    await appStarted(BEFORE_WINDOW);
    await outbound({ channel: "sms", status: "sent", sentAt: IN_WINDOW });
    await outbound({ channel: "sms", status: "delivered", sentAt: IN_WINDOW, deliveredAt: IN_WINDOW });
    await outbound({ channel: "sms", status: "undelivered", sentAt: IN_WINDOW, failedAt: IN_WINDOW });
    await outbound({ channel: "sms", status: "failed", failedAt: IN_WINDOW });
    await outbound({ channel: "sms", status: "sent", sentAt: BEFORE_WINDOW });
    await outbound({ channel: "email", status: "undelivered", sentAt: IN_WINDOW, failedAt: IN_WINDOW, errorCode: "bounce:Permanent:General" });
    await outbound({ channel: "email", status: "sent", sentAt: IN_WINDOW, dedupeKey: "alert:test_kind:2026-02-09T20", toAddress: "alerts@example.test" });
    await writeHeartbeat(db, BACKUP_HEARTBEAT_NAME, new Date(NOW.getTime() - 10 * 3_600_000));

    const d = await buildDigest(db, NOW);
    expect(d.started - before.started).toBe(2);
    expect(d.submitted - before.submitted).toBe(1);
    expect(d.textsSent - before.textsSent).toBe(3);
    expect(d.textsDelivered - before.textsDelivered).toBe(1);
    expect(d.textsUndelivered - before.textsUndelivered).toBe(1);
    expect(d.textsFailed - before.textsFailed).toBe(1);
    expect(d.emailsBounced - before.emailsBounced).toBe(1);
    expect(d.alerts.count - before.alerts.count).toBe(1);
    expect(d.alerts.kinds).toContain("test_kind");
    expect(d.unhandledTexts).toBe(await countUnhandledInbound(db));
    expect(d.backupAgeHours).toBe(10);

    const { subject, body } = renderDigest(d);
    expect(subject).toBe("Daily digest 2026-02-10");
    expect(body).toContain(`Texts sent: ${d.textsSent}`);
    expect(body).toContain("Last backup: 10 hours ago");
    expect(body).toContain("test_kind");
  });

  it("warns when a fifth or more of 10+ texts went undelivered", () => {
    const base = { date: "2026-02-10", from: NOW, to: NOW, started: 0, submitted: 0, textsDelivered: 0, textsFailed: 0, emailsBounced: 0, unhandledTexts: 0, alerts: { count: 0, kinds: [] }, lastBackupAt: null, backupAgeHours: null };
    expect(renderDigest({ ...base, textsSent: 10, textsUndelivered: 2 }).body).toContain("carriers are filtering");
    expect(renderDigest({ ...base, textsSent: 9, textsUndelivered: 9 }).body).not.toContain("carriers are filtering");
    expect(renderDigest({ ...base, textsSent: 0, textsUndelivered: 0 }).body).toContain("Last backup: never");
  });

  it("sends once per day, at or after 7am Central, to ALERT_EMAIL, and alerts on a stale backup", async () => {
    await db.delete(message).where(like(message.dedupeKey, `${DIGEST_DEDUPE_PREFIX}2026-02-10%`));
    await db.delete(message).where(like(message.dedupeKey, "alert:backup_stale:%"));
    await db.update(cronHeartbeat).set({ beatAt: new Date(NOW.getTime() - 40 * 3_600_000) }).where(eq(cronHeartbeat.name, BACKUP_HEARTBEAT_NAME));
    const sink = createSinkProviders();

    const early = await sendDailyDigest(db, { now: new Date("2026-02-10T12:59:00Z"), providers: sink });
    expect(early).toMatchObject({ sent: false, reason: "before_7am" });
    expect(sink.sent).toHaveLength(0);

    const first = await sendDailyDigest(db, { now: NOW, providers: sink });
    expect(first.sent).toBe(true);
    const digestEmails = sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("Daily digest"));
    expect(digestEmails).toHaveLength(1);
    expect(digestEmails[0]!.message.to).toBe("alerts@example.test");
    expect(digestEmails[0]!.message.body).toContain("Applications started:");
    const stale = sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("Backup is older than 36 hours"));
    expect(stale).toHaveLength(1);

    const second = await sendDailyDigest(db, { now: new Date(NOW.getTime() + 5 * 60_000), providers: sink });
    expect(second).toMatchObject({ sent: false, reason: "already_sent", messageId: first.messageId });
    expect(sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("Daily digest"))).toHaveLength(1);
  });
});
