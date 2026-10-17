import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { interview, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { transition } from "@/server/services/applications/transition";
import { queueInterviewReminders, reminderDueAt } from "@/server/services/messaging/interview-reminders";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { processMessages } from "@/server/services/messaging/send";
import { interviewReminderKey } from "@/server/services/messaging/template-text";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadEmployer, loadOption, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { createInterview, ensurePhase2Templates, readyEmployer, submittedApplicant } from "./helpers/templates";

// The one-on-one reminder (messaging/interview-reminders.ts): 5pm Central the day before,
// right away when the interview is 20 hours off or less, nothing under an hour or in the
// past; one per booked time, a new one when it is rescheduled, the old one canceled, and
// a canceled interview cancels its reminder. Daylight saving time ends Sun Nov 1, 2026.
// Every database case runs in a rolled-back transaction.

const at = (iso: string) => new Date(iso);
// Fri Oct 30, 2026 at noon CDT.
const NOW = at("2026-10-30T17:00:00Z");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let snow: SnowFixture;
let employerId: string;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

function scenario(fn: (tx: Tx) => Promise<void>) {
  return withRollback(db, async (tx) => {
    await ensurePhase2Templates(tx, adminId);
    await readyEmployer(tx, employerId);
    await fn(tx);
  });
}

function applicant(tx: Tx, options: Parameters<typeof submittedApplicant>[3] = {}) {
  return submittedApplicant(tx, snow, employerId, options);
}

async function reminders(tx: Tx, applicationId: string) {
  return tx
    .select()
    .from(message)
    .where(and(eq(message.applicationId, applicationId), eq(message.purpose, "one_on_one_reminder")))
    .orderBy(message.createdAt);
}

describe("when a reminder is due", () => {
  it("is 5pm Central the day before, on the right side of the Nov 1 change", () => {
    // Mon Nov 2 at 9:00am CST: the day before is Sun Nov 1, already standard time.
    expect(reminderDueAt(at("2026-11-02T15:00:00Z"), NOW, "sms")).toEqual(at("2026-11-01T23:00:00Z"));
    // Sun Nov 1 at 10:00am CST: the day before is Sat Oct 31, still daylight time.
    expect(reminderDueAt(at("2026-11-01T16:00:00Z"), NOW, "sms")).toEqual(at("2026-10-31T22:00:00Z"));
    // Tue Nov 3 at 2:30pm CST.
    expect(reminderDueAt(at("2026-11-03T20:30:00Z"), NOW, "email")).toEqual(at("2026-11-02T23:00:00Z"));
  });

  it("counts 20 hours of real time across the change, not wall-clock hours", () => {
    // Sat Oct 31 at 4:00pm CDT to Sun Nov 1 at 11:30am CST: 19.5 hours on the clock, 20.5 really.
    expect(reminderDueAt(at("2026-11-01T17:30:00Z"), at("2026-10-31T21:00:00Z"), "sms")).toEqual(at("2026-10-31T22:00:00Z"));
  });

  it("is right away from 1 to 20 hours ahead, and when 5pm the day before has passed", () => {
    const tuesday10am = at("2026-11-03T16:00:00Z");
    expect(reminderDueAt(at("2026-11-03T22:00:00Z"), tuesday10am, "sms")).toEqual(tuesday10am);
    expect(reminderDueAt(at("2026-11-04T12:00:00Z"), tuesday10am, "sms")).toEqual(tuesday10am); // exactly 20 hours
    expect(reminderDueAt(at("2026-11-03T17:00:00Z"), tuesday10am, "email")).toEqual(tuesday10am); // exactly 1 hour
    // Mon Nov 2 at 6pm CST for Tue at 11pm: 29 hours ahead, but 5pm Monday is gone.
    expect(reminderDueAt(at("2026-11-04T05:00:00Z"), at("2026-11-03T00:00:00Z"), "sms")).toEqual(at("2026-11-03T00:00:00Z"));
  });

  it("is never under an hour ahead or in the past", () => {
    const tuesday10am = at("2026-11-03T16:00:00Z");
    expect(reminderDueAt(at("2026-11-03T16:59:00Z"), tuesday10am, "email")).toBeNull();
    expect(reminderDueAt(at("2026-11-03T15:00:00Z"), tuesday10am, "email")).toBeNull();
  });

  it("holds a text for 9am Central, and gives none when that lands under an hour ahead", () => {
    const tuesday10pm = at("2026-11-04T04:00:00Z");
    // Wed at 2:00pm: the text waits for 9:00am.
    expect(reminderDueAt(at("2026-11-04T20:00:00Z"), tuesday10pm, "sms")).toEqual(at("2026-11-04T15:00:00Z"));
    // Wed at 9:30am: a 9:00am text is 30 minutes ahead, so no text; an email can go now.
    expect(reminderDueAt(at("2026-11-04T15:30:00Z"), tuesday10pm, "sms")).toBeNull();
    expect(reminderDueAt(at("2026-11-04T15:30:00Z"), tuesday10pm, "email")).toEqual(tuesday10pm);
  });
});

describe("queueInterviewReminders", () => {
  it("queues one text for 5pm the day before, with the time in Central, once", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const scheduledAt = at("2026-11-02T15:00:00Z");
      const id = await createInterview(tx, a.applicationId, { scheduledAt, bookedVia: "booking_link" });

      const summary = await queueInterviewReminders(tx, NOW);
      expect(summary.queued).toBeGreaterThanOrEqual(1);
      const [row, ...more] = await reminders(tx, a.applicationId);
      expect(more).toHaveLength(0);
      expect(row).toMatchObject({
        channel: "sms",
        status: "queued",
        toAddress: a.mobile,
        dedupeKey: interviewReminderKey(id, scheduledAt),
        triggeredByType: "system",
        sendAfter: at("2026-11-01T23:00:00Z"),
      });
      expect(row!.body).toBe(
        "Kahuna Window Cleaning: Hi Dana, reminder: your interview is Mon, Nov 2 at 9:00 AM. To change it, call or text 763-292-2259. Reply STOP to opt out.",
      );

      await queueInterviewReminders(tx, at("2026-10-30T17:05:00Z"));
      expect(await reminders(tx, a.applicationId)).toHaveLength(1);
    });
  });

  it("emails a person without a text opt-in, and goes right away when the interview is close", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx, { consent: "declined" });
      // Fri at 9:00pm CDT, 9 hours off.
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-10-31T02:00:00Z") });
      await queueInterviewReminders(tx, NOW);
      const [row] = await reminders(tx, a.applicationId);
      expect(row).toMatchObject({ channel: "email", sendAfter: NOW, subject: "Reminder: your interview with Kahuna Window Cleaning", toAddress: a.email });
      expect(row!.body).toContain("your interview with Kahuna Window Cleaning is Fri, Oct 30 at 9:00 PM.");
    });
  });

  it("queues nothing under an hour ahead, in the past, or for an interview that is not scheduled", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-10-30T17:45:00Z") });
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-10-29T17:00:00Z") });
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-11-05T17:00:00Z"), status: "canceled" });
      await createInterview(tx, a.applicationId, { scheduledAt: null });
      await queueInterviewReminders(tx, NOW);
      expect(await reminders(tx, a.applicationId)).toHaveLength(0);
    });
  });

  it("gives a rescheduled interview a new reminder and cancels the old one, and moving back revives it", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const first = at("2026-11-03T20:30:00Z");
      const second = at("2026-11-04T20:30:00Z");
      const id = await createInterview(tx, a.applicationId, { scheduledAt: first });
      await queueInterviewReminders(tx, NOW);

      await tx.update(interview).set({ scheduledAt: second }).where(eq(interview.id, id));
      const summary = await queueInterviewReminders(tx, at("2026-10-30T17:05:00Z"));
      expect(summary.canceled).toBeGreaterThanOrEqual(1);
      const rows = await reminders(tx, a.applicationId);
      expect(rows.map((r) => [r.dedupeKey, r.status, r.errorCode])).toEqual([
        [interviewReminderKey(id, first), "canceled", "interview_rescheduled"],
        [interviewReminderKey(id, second), "queued", null],
      ]);
      expect(rows[1]!.body).toContain("your interview is Wed, Nov 4 at 2:30 PM.");
      expect(rows[1]!.sendAfter).toEqual(at("2026-11-03T23:00:00Z"));

      // Back to the first time: that time's own reminder is queued again, and the second is canceled.
      await tx.update(interview).set({ scheduledAt: first }).where(eq(interview.id, id));
      await queueInterviewReminders(tx, at("2026-10-30T17:10:00Z"));
      expect((await reminders(tx, a.applicationId)).map((r) => [r.dedupeKey, r.status])).toEqual([
        [interviewReminderKey(id, first), "queued"],
        [interviewReminderKey(id, second), "canceled"],
      ]);
    });
  });

  it("cancels the reminder of a canceled, finished or deleted interview, or a closed application", async () => {
    await scenario(async (tx) => {
      const canceled = await applicant(tx);
      const held = await applicant(tx);
      const deleted = await applicant(tx);
      const closed = await applicant(tx);
      const scheduledAt = at("2026-11-05T17:00:00Z");
      const ids = {
        canceled: await createInterview(tx, canceled.applicationId, { scheduledAt }),
        held: await createInterview(tx, held.applicationId, { scheduledAt }),
        deleted: await createInterview(tx, deleted.applicationId, { scheduledAt }),
      };
      await createInterview(tx, closed.applicationId, { scheduledAt });
      await queueInterviewReminders(tx, NOW);
      for (const a of [canceled, held, deleted, closed]) expect((await reminders(tx, a.applicationId))[0]!.status).toBe("queued");

      await tx.update(interview).set({ status: "canceled" }).where(eq(interview.id, ids.canceled));
      await tx.update(interview).set({ status: "held" }).where(eq(interview.id, ids.held));
      await tx.update(interview).set({ deletedAt: NOW }).where(eq(interview.id, ids.deleted));
      const reasonOptionId = await loadOption(tx, "withdraw_reason", "took_another_job");
      await transition(tx, { action: "close", applicationId: closed.applicationId, actor: staffActor(adminId), outcome: "withdrew", reasonOptionId });
      await queueInterviewReminders(tx, at("2026-10-30T17:05:00Z"));

      const outcome = async (applicationId: string) => (await reminders(tx, applicationId)).map((r) => [r.status, r.errorCode]);
      expect(await outcome(canceled.applicationId)).toEqual([["canceled", "interview_canceled"]]);
      expect(await outcome(held.applicationId)).toEqual([["canceled", "interview_done"]]);
      expect(await outcome(deleted.applicationId)).toEqual([["canceled", "interview_canceled"]]);
      expect(await outcome(closed.applicationId)).toEqual([["canceled", "interview_canceled"]]);
    });
  });

  it("cancels a reminder still waiting when the interview has started", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-11-02T15:00:00Z") });
      await queueInterviewReminders(tx, NOW);
      // The daily cap held it past the interview.
      await tx.update(message).set({ sendAfter: at("2026-11-03T15:00:00Z") }).where(eq(message.applicationId, a.applicationId));
      await queueInterviewReminders(tx, at("2026-11-02T15:30:00Z"));
      expect((await reminders(tx, a.applicationId)).map((r) => [r.status, r.errorCode])).toEqual([["canceled", "interview_started"]]);
    });
  });

  it("says the same time in the email that replaces a text that cannot go", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await createInterview(tx, a.applicationId, { scheduledAt: at("2026-11-02T15:00:00Z") });
      await queueInterviewReminders(tx, NOW);
      const [text] = await reminders(tx, a.applicationId);

      // Texting is turned off before 5pm Sunday; the send falls back to email.
      await readyEmployer(tx, employerId, { smsEnabled: false });
      const sink = createSinkProviders();
      const summary = await processMessages(tx, [text!.id], sink, at("2026-11-01T23:00:00Z"));
      expect(summary.suppressed).toEqual([text!.id]);
      const email = (await reminders(tx, a.applicationId)).find((r) => r.channel === "email")!;
      expect(email).toMatchObject({ dedupeKey: `${text!.dedupeKey}:email`, subject: "Reminder: your interview with Kahuna Window Cleaning" });
      expect(email.body).toContain("your interview with Kahuna Window Cleaning is Mon, Nov 2 at 9:00 AM.");
      expect(sink.sent.map((s) => s.channel)).toEqual(["email"]);

      // A later pass leaves the suppressed text and its email alone.
      await readyEmployer(tx, employerId);
      await queueInterviewReminders(tx, at("2026-11-01T23:05:00Z"));
      expect(await tx.select().from(message).where(like(message.dedupeKey, `${text!.dedupeKey}%`))).toHaveLength(2);
    });
  });
});
