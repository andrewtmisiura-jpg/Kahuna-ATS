import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, employer, legalTextVersion, message, person } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { recordConsent } from "@/server/services/messaging/consent";
import { queueDueReminders, REMINDER_DEDUPE_PREFIX } from "@/server/services/messaging/reminders";
import { createApplication, createPerson, loadEmployer, loadOption, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

const PHONE_ID = "PNtest0001";
// A Tuesday at 11:00 CDT, inside the send window.
const NOON = new Date("2026-10-20T16:00:00Z");
// The same Tuesday at 10:00pm CDT, after the window closes.
const LATE = new Date("2026-10-21T03:00:00Z");
const HOUR = 3_600_000;

let snow: SnowFixture;
let employerId: string;
let smsConsentId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  await db.update(employer).set({ smsQuoPhoneNumberId: PHONE_ID, smsEnabled: true }).where(eq(employer.id, employerId));
  const [consent] = await db.select({ id: legalTextVersion.id }).from(legalTextVersion).where(eq(legalTextVersion.kind, "sms_consent"));
  smsConsentId = consent!.id;
});

afterAll(async () => {
  await db.update(employer).set({ smsQuoPhoneNumberId: null, smsEnabled: true }).where(eq(employer.id, employerId));
  await sql.end();
});

type Started = { applicationId: string; personId: string; mobile: string };

// An application started `hoursAgo` hours before `now`, with the given consent.
async function started(hoursAgo: number, options: { consent?: "opt_in" | "declined" | "none"; now?: Date; person?: Partial<typeof person.$inferInsert> } = {}): Promise<Started> {
  const now = options.now ?? NOON;
  const mobile = nextMobile();
  const personId = await createPerson(db, { mobileE164: mobile, firstName: "Remy", ...options.person });
  const { applicationId } = await createApplication(db, snow, personId);
  const startedAt = new Date(now.getTime() - hoursAgo * HOUR);
  await db.update(application).set({ startedAt, lastActivityAt: startedAt }).where(eq(application.id, applicationId));
  const consent = options.consent ?? "opt_in";
  if (consent !== "none") {
    await recordConsent(db, {
      personId,
      applicationId,
      employerId,
      channel: "sms",
      address: mobile,
      action: consent,
      method: "web_form",
      legalTextVersionId: smsConsentId,
      checkboxValue: consent === "opt_in",
      occurredAt: startedAt,
    });
  }
  return { applicationId, personId, mobile };
}

async function reminderFor(applicationId: string) {
  const [row] = await db.select().from(message).where(eq(message.dedupeKey, `${REMINDER_DEDUPE_PREFIX}${applicationId}`));
  return row ?? null;
}

describe("queueDueReminders", () => {
  it("queues one text for an opted-in application started 24 hours ago, inside the window right away", async () => {
    const a = await started(25);
    const summary = await queueDueReminders(db, NOON);
    const mine = summary.queued.find((q) => q.applicationId === a.applicationId);
    expect(mine).toMatchObject({ channel: "sms" });
    const m = await reminderFor(a.applicationId);
    expect(m).toMatchObject({ channel: "sms", purpose: "reminder_24h", status: "queued", personId: a.personId, applicationId: a.applicationId, toAddress: a.mobile, triggeredByType: "system" });
    expect(m!.sendAfter).toEqual(NOON);
    expect(m!.body).toContain("saved but not sent yet");

    // A second pass finds the dedupe key and queues nothing more.
    const again = await queueDueReminders(db, new Date(NOON.getTime() + 5 * 60_000));
    expect(again.queued.find((q) => q.applicationId === a.applicationId)).toBeUndefined();
    expect(await db.select().from(message).where(eq(message.applicationId, a.applicationId))).toHaveLength(1);
  });

  it("outside 9am to 8pm Central the reminder waits for the next 9am", async () => {
    const a = await started(26, { now: LATE });
    await queueDueReminders(db, LATE);
    const m = await reminderFor(a.applicationId);
    expect(m!.sendAfter?.toISOString()).toBe("2026-10-21T14:00:00.000Z");
  });

  it("goes by email when the box was left unchecked, when there is no consent, or when texting is off", async () => {
    const declined = await started(30, { consent: "declined" });
    const none = await started(30, { consent: "none" });
    await queueDueReminders(db, NOON);
    expect((await reminderFor(declined.applicationId))!.channel).toBe("email");
    expect((await reminderFor(none.applicationId))!.channel).toBe("email");

    const optedIn = await started(30);
    await db.update(employer).set({ smsEnabled: false }).where(eq(employer.id, employerId));
    try {
      await queueDueReminders(db, NOON);
    } finally {
      await db.update(employer).set({ smsEnabled: true }).where(eq(employer.id, employerId));
    }
    const m = await reminderFor(optedIn.applicationId);
    expect(m!.channel).toBe("email");
    expect(m!.subject).toBe("Your application isn't finished yet");
  });

  it("skips applications that are too young, too old, submitted, hired, closed, deleted or do-not-contact", async () => {
    const young = await started(23);
    const old = await started(8 * 24);
    const submitted = await started(30);
    await db.update(application).set({ submittedAt: new Date(NOON.getTime() - HOUR) }).where(eq(application.id, submitted.applicationId));
    const hired = await started(30);
    await db.update(application).set({ status: "hired" }).where(eq(application.id, hired.applicationId));
    const closed = await started(30);
    await db
      .update(application)
      .set({ status: "closed", closedOutcome: "withdrew", closedReasonOptionId: await loadOption(db, "withdraw_reason", "took_another_job") })
      .where(eq(application.id, closed.applicationId));
    const deleted = await started(30);
    await db.update(application).set({ deletedAt: NOON }).where(eq(application.id, deleted.applicationId));
    const dnc = await started(30, { person: { doNotContact: true } });

    await queueDueReminders(db, NOON);
    for (const a of [young, old, submitted, hired, closed, deleted, dnc]) {
      expect(await reminderFor(a.applicationId), a.applicationId).toBeNull();
    }
  });

  it("is a dedupe key, so a reminder already queued by anyone else is never doubled", async () => {
    const a = await started(30);
    const [existing] = await db
      .insert(message)
      .values({
        id: crypto.randomUUID(),
        direction: "outbound",
        channel: "email",
        personId: a.personId,
        applicationId: a.applicationId,
        purpose: "reminder_24h",
        toAddress: "x@example.test",
        fromAddress: "y@example.test",
        body: "already here",
        status: "sent",
        provider: "sink",
        dedupeKey: `${REMINDER_DEDUPE_PREFIX}${a.applicationId}`,
        triggeredByType: "system",
      })
      .returning({ id: message.id });
    const summary = await queueDueReminders(db, NOON);
    expect(summary.queued.find((q) => q.applicationId === a.applicationId)).toBeUndefined();
    expect((await reminderFor(a.applicationId))!.id).toBe(existing!.id);
  });
});
