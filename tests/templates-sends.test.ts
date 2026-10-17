import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, applicationEvent, auditLog, groupSession, message, messageTemplate } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { transition, type TransitionInput } from "@/server/services/applications/transition";
import { withMessages } from "@/server/services/messaging/after-transition";
import { recordStaffOptOut, suppress } from "@/server/services/messaging/consent";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { processMessages } from "@/server/services/messaging/send";
import { loadSendOptions, previewTemplateMessage, sendTemplateMessage } from "@/server/services/messaging/staff-sends";
import { STAFF_SEND_PURPOSES } from "@/server/services/messaging/template-text";
import { TemplateError } from "@/server/services/messaging/templates";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadEmployer, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { BOOKING_LINK, ensurePhase2Templates, liveTemplate, PHONE_ID, readyEmployer, submittedApplicant } from "./helpers/templates";

// Staff send templates only: the channel is chosen for them (a text with a current
// opt-in, otherwise email, the decline email first), the preview shows this person's
// values, and Send, the Move dialog's invite and the Close dialog's decline each queue
// exactly one message through queueMessage, audited, with the move or close rolled back
// when the message cannot go. Every case runs in a rolled-back transaction with the
// Phase 2 templates on file and texting connected.

// A Tuesday at 11:00 CDT, inside the send window.
const NOON = new Date("2026-10-20T16:00:00Z");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let snow: SnowFixture;
let stages: Record<string, string>;
let adminId: string;
let employerId: string;
let staff: { type: "staff"; userId: string };

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = { type: "staff", userId: adminId };
  employerId = (await loadEmployer(db)).id;
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

async function messagesFor(tx: Tx, applicationId: string) {
  return tx.select().from(message).where(eq(message.applicationId, applicationId));
}

async function eventSeq(tx: Tx, applicationId: string) {
  const [row] = await tx.select({ seq: application.eventSeq }).from(application).where(eq(application.id, applicationId));
  return row!.seq;
}

describe("choosing the channel", () => {
  it("texts a number with a current opt-in while texting is on", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      expect(await previewTemplateMessage(tx, a.applicationId, "status_update")).toMatchObject({ channel: "sms", to: a.mobile, note: null, problem: null });
    });
  });

  it("emails instead when the box was left unchecked, the number opted out, or texting is off, and says why", async () => {
    await scenario(async (tx) => {
      const declined = await applicant(tx, { consent: "declined" });
      expect(await previewTemplateMessage(tx, declined.applicationId, "status_update")).toMatchObject({
        channel: "email",
        to: declined.email,
        note: "By email, because their number has no text opt-in.",
      });

      const stopped = await applicant(tx);
      await recordStaffOptOut(tx, { personId: stopped.personId, employerId, address: stopped.mobile!, userId: adminId });
      expect((await previewTemplateMessage(tx, stopped.applicationId, "one_on_one_invite")).note).toBe("By email, because their number opted out of texts.");

      const optedIn = await applicant(tx);
      await readyEmployer(tx, employerId, { smsEnabled: false });
      expect((await previewTemplateMessage(tx, optedIn.applicationId, "status_update")).note).toBe("By email, because texting is off in Settings.");
    });
  });

  it("says plainly why nothing can be sent", async () => {
    await scenario(async (tx) => {
      const nowhere = await applicant(tx, { consent: "declined", person: { email: null, emailNormalized: null } });
      expect(await previewTemplateMessage(tx, nowhere.applicationId, "status_update")).toMatchObject({
        channel: null,
        problem: "Nothing can be sent: their number has no text opt-in, and they have no email on file.",
      });

      const blocked = await applicant(tx, { person: { doNotContact: true } });
      expect((await previewTemplateMessage(tx, blocked.applicationId, "status_update")).problem).toBe("Nothing can be sent: they are marked do not contact.");

      const bounced = await applicant(tx, { person: { mobileE164: null } });
      await suppress(tx, { channel: "email", address: bounced.email!, reason: "email_hard_bounce" });
      expect((await previewTemplateMessage(tx, bounced.applicationId, "decline")).problem).toBe(
        "Nothing can be sent: they have no mobile number, and their email bounced or was reported as spam.",
      );
    });
  });

  it("sends the decline by email first, and by text only without an email", async () => {
    await scenario(async (tx) => {
      const both = await applicant(tx);
      expect(await previewTemplateMessage(tx, both.applicationId, "decline")).toMatchObject({
        channel: "email",
        note: "By email: a decline reads better in an inbox.",
        subject: "Your application with Kahuna Window Cleaning",
      });
      const textOnly = await applicant(tx, { person: { email: null, emailNormalized: null } });
      expect(await previewTemplateMessage(tx, textOnly.applicationId, "decline")).toMatchObject({
        channel: "sms",
        note: "By text, because they have no email on file.",
      });
    });
  });
});

describe("the preview", () => {
  it("fills in this person's values, keeps the application link a placeholder and counts the text", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const invite = await previewTemplateMessage(tx, a.applicationId, "one_on_one_invite");
      expect(invite.body).toBe(`Kahuna Window Cleaning: Hi Dana, we'd like to interview you. Pick a time here: ${BOOKING_LINK} Reply STOP to opt out.`);
      expect(invite).toMatchObject({ characters: 152, segments: 1 });

      const update = await previewTemplateMessage(tx, a.applicationId, "status_update");
      expect(update.body).toBe("Kahuna Window Cleaning: Hi Dana, there's an update on your job application. See it here: [application link] Reply STOP to opt out.");
      // Counted with a link as long as the one the send mints.
      expect(update.segments).toBe(2);
    });
  });

  it("refuses the invite until the booking link is set, and a message with no template", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await readyEmployer(tx, employerId, { bookingLinkUrl: null });
      expect((await previewTemplateMessage(tx, a.applicationId, "one_on_one_invite")).problem).toBe(
        "Add the booking link at the top of Settings, Message templates first.",
      );
      await expect(
        sendTemplateMessage(tx, { applicationId: a.applicationId, purpose: "one_on_one_invite", actor: staff, dedupeKey: `t:${uuidv7()}` }),
      ).rejects.toThrow(TemplateError);
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);

      await tx
        .update(messageTemplate)
        .set({ archivedAt: new Date() })
        .where(and(eq(messageTemplate.purpose, "status_update"), eq(messageTemplate.channel, "sms")));
      expect((await previewTemplateMessage(tx, a.applicationId, "status_update")).problem).toBe(
        "There is no text template for the status update. An Admin can check Settings, Message templates.",
      );
    });
  });

  it("gives {session_date} as their group session in Central time, and refuses it without one", async () => {
    await scenario(async (tx) => {
      const withSession = await applicant(tx, { consent: "declined" });
      const without = await applicant(tx, { consent: "declined" });
      const sessionId = uuidv7();
      await tx.insert(groupSession).values({
        id: sessionId,
        openingId: snow.openingId,
        startsAt: new Date("2026-11-03T00:00:00Z"),
        locationName: "Golden Valley shop",
        status: "scheduled",
        createdBy: adminId,
      });
      await tx.update(application).set({ attributedSessionId: sessionId }).where(eq(application.id, withSession.applicationId));
      const template = await liveTemplate(tx, employerId, "status_update", "email");
      await tx.update(messageTemplate).set({ body: `${template.body}\n\nWe met you at the group session on {session_date}.` }).where(eq(messageTemplate.id, template.id));

      expect((await previewTemplateMessage(tx, withSession.applicationId, "status_update")).body).toContain("at the group session on Mon, Nov 2 at 6:00 PM.");
      expect((await previewTemplateMessage(tx, without.applicationId, "status_update")).problem).toBe(
        "This message gives their group session date, but they have no group session.",
      );
    });
  });

  it("previews all three choices for the profile, and nothing for a deleted application", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const options = await loadSendOptions(tx, a.applicationId, STAFF_SEND_PURPOSES);
      // The decline waits for a close (see Send a message below).
      expect(options!.map((o) => [o.purpose, o.channel])).toEqual([
        ["one_on_one_invite", "sms"],
        ["status_update", "sms"],
        ["decline", null],
      ]);
      await tx.update(application).set({ deletedAt: new Date() }).where(eq(application.id, a.applicationId));
      expect(await loadSendOptions(tx, a.applicationId, STAFF_SEND_PURPOSES)).toBeNull();
    });
  });
});

describe("Send a message", () => {
  it("queues one message, audited, and a retried click queues nothing more", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const key = `staff_send:status_update:${uuidv7()}`;
      const first = await sendTemplateMessage(tx, { applicationId: a.applicationId, purpose: "status_update", actor: staff, dedupeKey: key, now: NOON });
      expect(first).toMatchObject({ channel: "sms", created: true });
      const again = await sendTemplateMessage(tx, { applicationId: a.applicationId, purpose: "status_update", actor: staff, dedupeKey: key, now: NOON });
      expect(again).toEqual({ ...first, created: false });

      const rows = await messagesFor(tx, a.applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "status_update",
        channel: "sms",
        status: "queued",
        toAddress: a.mobile,
        triggeredByType: "staff",
        triggeredByUserId: adminId,
        dedupeKey: key,
      });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.applicationId, a.applicationId), eq(auditLog.action, "application.message_send")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.changes).toEqual({ purpose: "status_update", channel: "sms", message_id: first.messageId, via: "profile", application_event_id: null });
    });
  });

  it("refuses the decline while the application is open, so it never skips the Close dialog's FCRA gate", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await transition(tx, { action: "move", applicationId: a.applicationId, toStageId: stages.conditional_offer!, actor: staff });
      await transition(tx, { action: "move", applicationId: a.applicationId, toStageId: stages.background_check!, actor: staff, check: { checkType: "criminal" } });
      const refusal =
        "The decline goes only to someone closed as Disqualified or Not selected. For someone still open, use Close and tick Send the decline message.";

      const options = await loadSendOptions(tx, a.applicationId, STAFF_SEND_PURPOSES);
      expect(options!.find((o) => o.purpose === "decline")).toMatchObject({ channel: null, body: null, problem: refusal });
      const decline = { applicationId: a.applicationId, purpose: "decline" as const, actor: staff, dedupeKey: `staff_send:decline:${uuidv7()}`, now: NOON };
      await expect(sendTemplateMessage(tx, decline)).rejects.toThrow(refusal);
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);

      // The Close dialog still previews the decline it would send with the close.
      expect(await previewTemplateMessage(tx, a.applicationId, "decline")).toMatchObject({ channel: "email", problem: null });

      // Closed through the gate, with the statement that the decision does not rely on the report, the decline can go.
      const reasonOptionId = await loadOption(tx, "disqualify_reason", "availability_conflict");
      await transition(tx, { action: "close", applicationId: a.applicationId, actor: staff, outcome: "disqualified", reasonOptionId, fcra: { notReportBased: true } });
      expect(await sendTemplateMessage(tx, decline)).toMatchObject({ channel: "email", created: true });
      expect(await messagesFor(tx, a.applicationId)).toEqual([expect.objectContaining({ purpose: "decline", status: "queued" })]);
    });
  });

  it("refuses the decline to someone who withdrew", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const reasonOptionId = await loadOption(tx, "withdraw_reason", "took_another_job");
      await transition(tx, { action: "close", applicationId: a.applicationId, actor: staff, outcome: "withdrew", reasonOptionId });
      await expect(
        sendTemplateMessage(tx, { applicationId: a.applicationId, purpose: "decline", actor: staff, dedupeKey: `staff_send:decline:${uuidv7()}` }),
      ).rejects.toThrow("The decline goes only to someone closed as Disqualified or Not selected.");
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);
    });
  });
});

describe("the invite a move sends", () => {
  it("queues exactly one one-on-one invite with the booking link, which then goes out as a text", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const move: TransitionInput = {
        action: "move",
        applicationId: a.applicationId,
        toStageId: stages.one_on_one_invited!,
        actor: staffActor(adminId),
        expectedSeq: await eventSeq(tx, a.applicationId),
      };
      const result = await transition(tx, withMessages(move, { sendInvite: true }));

      const rows = await messagesFor(tx, a.applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "one_on_one_invite",
        channel: "sms",
        status: "queued",
        dedupeKey: `invite:${result.event.id}`,
        triggeredByType: "staff",
        sendAfter: null,
      });
      expect(rows[0]!.body).toBe(`Kahuna Window Cleaning: Hi Dana, we'd like to interview you. Pick a time here: ${BOOKING_LINK} Reply STOP to opt out.`);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.applicationId, a.applicationId), eq(auditLog.action, "application.message_send")));
      expect(audit!.changes).toMatchObject({ purpose: "one_on_one_invite", via: "move", application_event_id: result.event.id });

      // The cron's send: a text from the hiring number with the real booking link.
      const sink = createSinkProviders();
      const summary = await processMessages(tx, [rows[0]!.id], sink, NOON);
      expect(summary.sent).toEqual([rows[0]!.id]);
      expect(sink.sent).toHaveLength(1);
      const sent = sink.sent[0]!;
      expect(sent.channel).toBe("sms");
      if (sent.channel === "sms") {
        expect(sent.message.fromPhoneNumberId).toBe(PHONE_ID);
        expect(sent.message.body).toContain(BOOKING_LINK);
        expect(sent.message.body).toContain("Hi Dana");
      }
    });
  });

  it("sends nothing on a move that does not ask for it, like a board drag", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await transition(tx, { action: "move", applicationId: a.applicationId, toStageId: stages.one_on_one_invited!, actor: staff });
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);
    });
  });

  it("rolls the move back when the invite cannot go, or when the move is not into an invited stage", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      await readyEmployer(tx, employerId, { bookingLinkUrl: null });
      const before = await eventSeq(tx, a.applicationId);
      const move: TransitionInput = { action: "move", applicationId: a.applicationId, toStageId: stages.one_on_one_invited!, actor: staff };
      await expect(transition(tx, withMessages(move, { sendInvite: true }))).rejects.toThrow("Add the booking link at the top of Settings, Message templates first.");
      expect(await eventSeq(tx, a.applicationId)).toBe(before);
      const moves = await tx.select().from(applicationEvent).where(and(eq(applicationEvent.applicationId, a.applicationId), eq(applicationEvent.kind, "stage_changed")));
      expect(moves).toHaveLength(0);

      await readyEmployer(tx, employerId);
      const reviewed: TransitionInput = { action: "move", applicationId: a.applicationId, toStageId: stages.reviewed!, actor: staff };
      await expect(transition(tx, withMessages(reviewed, { sendInvite: true }))).rejects.toThrow("The invite goes with a move into a one-on-one invited stage.");
      expect(await eventSeq(tx, a.applicationId)).toBe(before);
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);
    });
  });
});

describe("the decline a close sends", () => {
  it("queues one decline, by email, on a disqualified close", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const reasonOptionId = await loadOption(tx, "disqualify_reason", "availability_conflict");
      const close: TransitionInput = { action: "close", applicationId: a.applicationId, actor: staff, outcome: "disqualified", reasonOptionId };
      const result = await transition(tx, withMessages(close, { sendDecline: true }));
      const rows = await messagesFor(tx, a.applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: "decline", channel: "email", dedupeKey: `decline:${result.event.id}`, toAddress: a.email });
      expect(rows[0]!.body).toContain("We won't be moving forward with your application this time.");
      expect(rows[0]!.body).toContain("Snow Removal Technician (on-call)");
    });
  });

  it("refuses the decline on a withdrawal and keeps the application open", async () => {
    await scenario(async (tx) => {
      const a = await applicant(tx);
      const reasonOptionId = await loadOption(tx, "withdraw_reason", "took_another_job");
      const close: TransitionInput = { action: "close", applicationId: a.applicationId, actor: staff, outcome: "withdrew", reasonOptionId };
      await expect(transition(tx, withMessages(close, { sendDecline: true }))).rejects.toThrow(
        "The decline goes with closing someone as Disqualified or Not selected.",
      );
      const [row] = await tx.select({ status: application.status }).from(application).where(eq(application.id, a.applicationId));
      expect(row!.status).toBe("open");
      expect(await messagesFor(tx, a.applicationId)).toHaveLength(0);
    });
  });
});
