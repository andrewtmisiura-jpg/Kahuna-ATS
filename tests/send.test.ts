import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, consentEvent, employer, legalTextVersion, message, person, resumeToken, suppression } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { recordConsent, recordStaffOptOut } from "@/server/services/messaging/consent";
import { recordInboundText } from "@/server/services/messaging/inbound";
import { createSinkProviders, ProviderError, type SinkProviders } from "@/server/services/messaging/providers";
import {
  FULL_DISCLOSURE,
  processMessages,
  queueMessage,
  reapStuckMessages,
  SendError,
  sendDueMessages,
  withFullDisclosure,
  type QueueRequest,
} from "@/server/services/messaging/send";
import { notifyAdmin } from "@/server/services/notify";
import { createApplication, createPerson, loadAdminId, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

const PHONE_ID = "PNtest0001";
const HIRING_NUMBER = "+17632922259";
// A Tuesday at 11:00 CDT, inside the send window.
const NOON = new Date("2026-10-20T16:00:00Z");

let snow: SnowFixture;
let employerId: string;
let adminId: string;
let smsConsentId: string;
let sink: SinkProviders;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  const emp = await loadEmployer(db);
  employerId = emp.id;
  adminId = await loadAdminId(db);
  // quo:connect fills this in production; no text can go while it is null.
  await db.update(employer).set({ smsQuoPhoneNumberId: PHONE_ID, smsEnabled: true }).where(eq(employer.id, employerId));
  const [consent] = await db.select({ id: legalTextVersion.id }).from(legalTextVersion).where(eq(legalTextVersion.kind, "sms_consent"));
  smsConsentId = consent!.id;
});

afterAll(async () => {
  await db.update(employer).set({ smsQuoPhoneNumberId: null, dailySendCap: 200, smsEnabled: true }).where(eq(employer.id, employerId));
  await sql.end();
});

beforeEach(() => {
  sink = createSinkProviders();
});

type Applicant = { personId: string; applicationId: string; mobile: string; email: string };

// A person with an application and, by default, a web-form opt-in an hour before NOON.
async function applicant(options: { consent?: "opt_in" | "declined" | "none"; at?: Date } = {}): Promise<Applicant> {
  const mobile = nextMobile();
  const personId = await createPerson(db, { mobileE164: mobile, firstName: "Ana" });
  const [row] = await db.select({ email: person.email }).from(person).where(eq(person.id, personId));
  const { applicationId } = await createApplication(db, snow, personId);
  const action = options.consent ?? "opt_in";
  if (action !== "none") {
    await recordConsent(db, {
      personId,
      applicationId,
      employerId,
      channel: "sms",
      address: mobile,
      action,
      method: "web_form",
      legalTextVersionId: smsConsentId,
      checkboxValue: action === "opt_in",
      occurredAt: new Date((options.at ?? NOON).getTime() - 3_600_000),
    });
  }
  return { personId, applicationId, mobile, email: row!.email! };
}

function queue(a: Applicant, overrides: Partial<QueueRequest> & { purpose?: "resume_link" | "reminder_24h" | "link_recovery" } = {}) {
  const { purpose = "reminder_24h", ...rest } = overrides;
  return queueMessage(db, {
    employerId,
    channel: "sms",
    personId: a.personId,
    applicationId: a.applicationId,
    content: { purpose },
    triggeredBy: { type: "system" },
    now: NOON,
    ...rest,
  });
}

async function row(id: string) {
  const [m] = await db.select().from(message).where(eq(message.id, id));
  return m!;
}

describe("sending texts", () => {
  it("texts an opted-in number, mints the link at send and stores only the placeholder", async () => {
    const a = await applicant();
    const { messageId } = await queue(a, { purpose: "resume_link" });
    const summary = await processMessages(db, [messageId], sink, NOON);
    expect(summary.sent).toEqual([messageId]);

    const sent = await row(messageId);
    expect(sent.status).toBe("sent");
    expect(sent.provider).toBe("sink");
    expect(sent.sentAt).toEqual(NOON);
    expect(sent.attempts).toBe(1);
    expect(sent.providerMessageId).toMatch(/^sink_/);
    expect(sent.body).toMatch(/\{link:[0-9a-f-]{36}\}/);
    expect(sent.body).toContain("Hi Ana");

    expect(sink.sent).toHaveLength(1);
    const delivered = sink.sent[0]!;
    expect(delivered.channel).toBe("sms");
    expect(delivered.message.to).toBe(a.mobile);
    if (delivered.channel === "sms") expect(delivered.message.fromPhoneNumberId).toBe(PHONE_ID);
    const token = /r#([A-Za-z0-9_-]+)/.exec(delivered.message.body)?.[1];
    expect(token).toBeDefined();
    expect(delivered.message.body).toContain(`https://tidepool.kahunawindowcleaning.com/r#${token}`);

    // The plaintext is nowhere in the database.
    const [tokenRow] = await db.select().from(resumeToken).where(eq(resumeToken.messageId, messageId));
    expect(tokenRow!.applicationId).toBe(a.applicationId);
    expect(tokenRow!.issuedVia).toBe("message");
    const messages = await db.select().from(message).where(eq(message.applicationId, a.applicationId));
    expect(JSON.stringify(messages)).not.toContain(token);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(token);
    // The template already carries the full disclosure, so it appears once.
    expect(delivered.message.body.split(FULL_DISCLOSURE)).toHaveLength(2);
  });

  it("the first text since the opt-in carries the full disclosure, the second does not", async () => {
    const a = await applicant();
    const first = await queue(a, { dedupeKey: `test-first:${a.applicationId}` });
    await processMessages(db, [first.messageId], sink, NOON);
    const firstBody = sink.sent[0]!.message.body;
    expect(firstBody.endsWith(FULL_DISCLOSURE)).toBe(true);
    expect(firstBody).not.toMatch(/Reply STOP to opt out\. Msg frequency/);
    expect((await row(first.messageId)).body!.endsWith(FULL_DISCLOSURE)).toBe(true);

    const second = await queue(a, { now: new Date(NOON.getTime() + 60_000) });
    await processMessages(db, [second.messageId], sink, new Date(NOON.getTime() + 60_000));
    expect(sink.sent[1]!.message.body.endsWith("Reply STOP to opt out.")).toBe(true);
    expect(sink.sent[1]!.message.body).not.toContain("Msg frequency varies");
  });

  it("falls back to email when the box was left unchecked, and suppresses a link text that has its own email", async () => {
    const a = await applicant({ consent: "declined" });
    const reminder = await queue(a);
    const summary = await processMessages(db, [reminder.messageId], sink, NOON);
    expect(summary.suppressed).toEqual([reminder.messageId]);
    expect(summary.sent).toHaveLength(1);
    const text = await row(reminder.messageId);
    expect(text.status).toBe("suppressed");
    expect(text.errorCode).toBe("no_opt_in");
    const fallback = await row(summary.sent[0]!);
    expect(fallback.channel).toBe("email");
    expect(fallback.purpose).toBe("reminder_24h");
    expect(fallback.toAddress).toBe(a.email);
    expect(fallback.status).toBe("sent");
    expect(sink.sent[0]!.channel).toBe("email");
    if (sink.sent[0]!.channel === "email") expect(sink.sent[0]!.message.subject).toBe("Your application isn't finished yet");

    const link = await queue(a, { purpose: "resume_link" });
    const linkSummary = await processMessages(db, [link.messageId], sink, NOON);
    expect(linkSummary.suppressed).toEqual([link.messageId]);
    expect(linkSummary.sent).toHaveLength(0);
  });

  it("re-opting in after a decline sends again, and a staff-edited number has no opt-in", async () => {
    const a = await applicant({ consent: "declined" });
    await recordConsent(db, {
      personId: a.personId,
      applicationId: a.applicationId,
      employerId,
      channel: "sms",
      address: a.mobile,
      action: "opt_in",
      method: "web_form",
      legalTextVersionId: smsConsentId,
      checkboxValue: true,
      occurredAt: new Date(NOON.getTime() - 60_000),
    });
    const first = await queue(a);
    expect((await processMessages(db, [first.messageId], sink, NOON)).sent).toEqual([first.messageId]);

    // Staff correct the number on file: consent belonged to the old number.
    const newMobile = nextMobile();
    await db.update(person).set({ mobileE164: newMobile }).where(eq(person.id, a.personId));
    const second = await queue(a, { dedupeKey: `test-edited:${a.applicationId}` });
    const summary = await processMessages(db, [second.messageId], sink, NOON);
    expect(summary.suppressed).toEqual([second.messageId]);
    expect((await row(second.messageId)).errorCode).toBe("no_opt_in");
    expect(summary.sent).toHaveLength(1);
    expect((await row(summary.sent[0]!)).channel).toBe("email");
    expect(sink.sent.filter((s) => s.channel === "sms" && s.message.to === newMobile)).toHaveLength(0);
  });

  it("STOP blocks texts and START lets them through again", async () => {
    const a = await applicant();
    const stop = await recordInboundText(db, {
      providerMessageId: `in-stop-${a.personId}`,
      from: a.mobile,
      to: HIRING_NUMBER,
      body: "STOP",
      receivedAt: NOON,
      now: NOON,
    });
    expect(stop.kind).toBe("stop");
    const blocked = await queue(a, { now: new Date(NOON.getTime() + 1000) });
    const summary = await processMessages(db, [blocked.messageId], sink, new Date(NOON.getTime() + 1000));
    expect((await row(blocked.messageId)).errorCode).toBe("suppressed");
    expect(summary.sent).toHaveLength(1); // the email fallback
    expect(sink.sent.every((s) => s.channel === "email")).toBe(true);

    const start = await recordInboundText(db, {
      providerMessageId: `in-start-${a.personId}`,
      from: a.mobile,
      to: HIRING_NUMBER,
      body: "start",
      receivedAt: new Date(NOON.getTime() + 2000),
      now: new Date(NOON.getTime() + 2000),
    });
    expect(start.kind).toBe("start");
    const later = new Date(NOON.getTime() + 3000);
    const again = await queue(a, { now: later, dedupeKey: `test-start:${a.applicationId}` });
    expect((await processMessages(db, [again.messageId], sink, later)).sent).toEqual([again.messageId]);
    expect(sink.sent.at(-1)!.channel).toBe("sms");
  });

  it("do-not-contact blocks every channel with no fallback", async () => {
    const a = await applicant();
    await db.update(person).set({ doNotContact: true }).where(eq(person.id, a.personId));
    const text = await queue(a);
    const mail = await queue(a, { channel: "email", purpose: "reminder_24h", dedupeKey: `test-dnc:${a.applicationId}` });
    const summary = await processMessages(db, [text.messageId, mail.messageId], sink, NOON);
    expect(summary.suppressed).toEqual([text.messageId, mail.messageId]);
    expect(summary.sent).toHaveLength(0);
    expect(sink.sent).toHaveLength(0);
    expect((await row(text.messageId)).errorCode).toBe("do_not_contact");
  });

  it("falls back to email while texting is switched off", async () => {
    const a = await applicant();
    await db.update(employer).set({ smsEnabled: false }).where(eq(employer.id, employerId));
    try {
      const { messageId } = await queue(a);
      const summary = await processMessages(db, [messageId], sink, NOON);
      expect((await row(messageId)).errorCode).toBe("sms_disabled");
      expect(summary.sent).toHaveLength(1);
      expect(sink.sent[0]!.channel).toBe("email");
    } finally {
      await db.update(employer).set({ smsEnabled: true }).where(eq(employer.id, employerId));
    }
  });

  it("a staff-recorded opt-out suppresses the number too", async () => {
    const a = await applicant();
    await recordStaffOptOut(db, { personId: a.personId, applicationId: a.applicationId, employerId, address: a.mobile, userId: adminId, now: NOON });
    const { messageId } = await queue(a, { now: new Date(NOON.getTime() + 1000) });
    await processMessages(db, [messageId], sink, new Date(NOON.getTime() + 1000));
    expect((await row(messageId)).status).toBe("suppressed");
    const [s] = await db.select().from(suppression).where(eq(suppression.address, a.mobile));
    expect(s!.reason).toBe("staff_marked");
    expect(s!.createdBy).toBe(adminId);
  });
});

describe("quiet hours and the cron pass", () => {
  it("holds a reminder outside 9am to 8pm Central, even on the DST night, and sends a link at once", async () => {
    const a = await applicant({ at: new Date("2026-11-01T06:30:00Z") });
    const night = new Date("2026-11-01T06:30:00Z"); // 01:30 CDT
    const reminder = await queue(a, { now: night });
    const link = await queue(a, { purpose: "resume_link", now: night });
    const summary = await processMessages(db, [reminder.messageId, link.messageId], sink, night);
    expect(summary.deferred).toEqual([reminder.messageId]);
    expect(summary.sent).toEqual([link.messageId]);
    const held = await row(reminder.messageId);
    expect(held.status).toBe("queued");
    expect(held.sendAfter?.toISOString()).toBe("2026-11-01T15:00:00.000Z"); // 9:00 CST, not CDT

    const tooEarly = await sendDueMessages(db, sink, { now: new Date("2026-11-01T14:30:00Z") });
    expect(tooEarly.sent).not.toContain(reminder.messageId);
    const morning = await sendDueMessages(db, sink, { now: new Date("2026-11-01T15:00:00Z") });
    expect(morning.sent).toContain(reminder.messageId);
  });

  it("sends a due row exactly once under two concurrent cron passes", async () => {
    const a = await applicant();
    const { messageId } = await queue(a, { dedupeKey: `reminder_24h:${a.applicationId}` });
    const sinkA = createSinkProviders();
    const sinkB = createSinkProviders();
    const [passA, passB] = await Promise.all([
      sendDueMessages(db, sinkA, { now: NOON }),
      sendDueMessages(db, sinkB, { now: NOON }),
    ]);
    const sends = [...sinkA.sent, ...sinkB.sent].filter((s) => s.message.messageId === messageId);
    expect(sends).toHaveLength(1);
    expect([...passA.sent, ...passB.sent].filter((id) => id === messageId)).toHaveLength(1);
    expect((await row(messageId)).attempts).toBe(1);
  });

  it("queues a dedupe key once and refuses a fourth link send in an hour", async () => {
    const a = await applicant();
    const key = `reminder_24h:${a.applicationId}`;
    const first = await queue(a, { dedupeKey: key });
    const second = await queue(a, { dedupeKey: key });
    expect(first.created).toBe(true);
    expect(second).toEqual({ messageId: first.messageId, created: false });

    await queue(a, { purpose: "resume_link" });
    await queue(a, { purpose: "link_recovery" });
    await queue(a, { purpose: "resume_link" });
    await expect(queue(a, { purpose: "link_recovery" })).rejects.toMatchObject({ code: "link_rate_limited" });
    await expect(queue(a, { purpose: "link_recovery", now: new Date(NOON.getTime() + 2 * 3_600_000) })).resolves.toBeDefined();
  });

  it("stops at the daily cap and queues the rest for tomorrow 9am", async () => {
    const a = await applicant();
    await db.update(employer).set({ dailySendCap: 0 }).where(eq(employer.id, employerId));
    try {
      const { messageId } = await queue(a);
      const summary = await processMessages(db, [messageId], sink, NOON);
      expect(summary.capReached).toBe(true);
      expect(summary.deferred).toEqual([messageId]);
      expect((await row(messageId)).sendAfter?.toISOString()).toBe("2026-10-21T14:00:00.000Z");
    } finally {
      await db.update(employer).set({ dailySendCap: 200 }).where(eq(employer.id, employerId));
    }
  });
});

describe("provider failures", () => {
  it("retries a transient failure and gives up after three attempts", async () => {
    const a = await applicant();
    const { messageId } = await queue(a);
    sink.failures.push(new ProviderError("transient", "Quo 503"));
    let summary = await processMessages(db, [messageId], sink, NOON);
    expect(summary.deferred).toEqual([messageId]);
    let m = await row(messageId);
    expect(m.status).toBe("queued");
    expect(m.attempts).toBe(1);
    expect(m.sendAfter!.getTime()).toBeGreaterThan(NOON.getTime());

    sink.failures.push(new ProviderError("transient", "Quo 503"), new ProviderError("transient", "Quo 503"));
    const later = new Date(NOON.getTime() + 10 * 60_000);
    await processMessages(db, [messageId], sink, later);
    summary = await processMessages(db, [messageId], sink, later);
    expect(summary.failed).toEqual([messageId]);
    m = await row(messageId);
    expect(m.status).toBe("failed");
    expect(m.attempts).toBe(3);
    expect(m.failedAt).toEqual(later);
    // The failed text still fell back to email.
    expect(sink.sent.filter((s) => s.channel === "email")).toHaveLength(0);
  });

  it("records a carrier opt-out as carrier_blocked with a consent event and falls back to email", async () => {
    const a = await applicant();
    const { messageId } = await queue(a);
    sink.failures.push(new ProviderError("opted_out", "Quo 400: recipient opted out", "400"));
    const summary = await processMessages(db, [messageId], sink, NOON);
    expect(summary.failed).toEqual([messageId]);
    expect(summary.sent).toHaveLength(1);
    expect(sink.sent[0]!.channel).toBe("email");
    const [s] = await db.select().from(suppression).where(eq(suppression.address, a.mobile));
    expect(s!.reason).toBe("carrier_blocked");
    expect(s!.messageId).toBe(messageId);
    const consents = await db.select().from(consentEvent).where(eq(consentEvent.messageId, messageId));
    expect(consents[0]?.action).toBe("opt_out");
  });

  it("an empty Quo balance fails the text, falls back to email and stops texting for the pass", async () => {
    const a = await applicant();
    const b = await applicant();
    const first = await queue(a, { dedupeKey: `test-balance-a:${a.applicationId}` });
    const second = await queue(b, { dedupeKey: `test-balance-b:${b.applicationId}` });
    sink.failures.push(new ProviderError("insufficient_balance", "Quo 402", "402"));
    const summary = await processMessages(db, [first.messageId, second.messageId], sink, NOON);
    expect(summary.balanceEmpty).toBe(true);
    expect(summary.failed).toEqual([first.messageId]);
    expect((await row(first.messageId)).errorCode).toBe("402");
    // The second text was never handed to the provider and is queued again, untouched.
    const untouched = await row(second.messageId);
    expect(untouched.status).toBe("queued");
    expect(untouched.attempts).toBe(0);
    expect(sink.sent.filter((s) => s.channel === "sms")).toHaveLength(0);
    expect(sink.sent.filter((s) => s.channel === "email").map((s) => s.message.to)).toEqual([a.email]);
  });

  it("marks a text stuck in sending as unknown and requeues a stuck email", async () => {
    const a = await applicant();
    const text = await queue(a);
    const mail = await queue(a, { channel: "email", dedupeKey: `test-stuck:${a.applicationId}` });
    const stuckSince = new Date(NOON.getTime() - 30 * 60_000);
    await db.update(message).set({ status: "sending", lockedAt: stuckSince }).where(eq(message.id, text.messageId));
    await db.update(message).set({ status: "sending", lockedAt: stuckSince }).where(eq(message.id, mail.messageId));
    expect(await reapStuckMessages(db, NOON)).toEqual({ unknown: 1, requeued: 1 });
    expect((await row(text.messageId)).status).toBe("unknown");
    expect((await row(mail.messageId)).status).toBe("queued");
  });
});

describe("queue validation", () => {
  it("refuses a text to a person without a mobile number", async () => {
    const personId = await createPerson(db, { mobileE164: null });
    const { applicationId } = await createApplication(db, snow, personId);
    await expect(
      queueMessage(db, { employerId, channel: "sms", personId, applicationId, content: { purpose: "resume_link" }, triggeredBy: { type: "system" } }),
    ).rejects.toBeInstanceOf(SendError);
  });

  it("appends the disclosure to a body without the short closing", () => {
    expect(withFullDisclosure("Hi there. Reply STOP to opt out.")).toBe(`Hi there. ${FULL_DISCLOSURE}`);
    expect(withFullDisclosure("Hi there.")).toBe(`Hi there. ${FULL_DISCLOSURE}`);
    expect(withFullDisclosure(`Hi. ${FULL_DISCLOSURE}`)).toBe(`Hi. ${FULL_DISCLOSURE}`);
  });
});

describe("notifyAdmin", () => {
  it("emails the alert address once per kind per hour", async () => {
    const first = await notifyAdmin(db, "test_alert", "Something failed", "message 123", { providers: sink, now: NOON });
    const again = await notifyAdmin(db, "test_alert", "Something failed again", "message 456", { providers: sink, now: new Date(NOON.getTime() + 20 * 60_000) });
    const other = await notifyAdmin(db, "test_other", "Other", "x", { providers: sink, now: NOON });
    const nextHour = await notifyAdmin(db, "test_alert", "Next hour", "x", { providers: sink, now: new Date(NOON.getTime() + 3_600_000) });
    expect(first.queued).toBe(true);
    expect(again).toEqual({ queued: false, messageId: first.messageId });
    expect(other.queued).toBe(true);
    expect(nextHour.queued).toBe(true);
    expect(sink.sent).toHaveLength(3);
    expect(sink.sent[0]!.message.to).toBe("alerts@example.test");
    if (sink.sent[0]!.channel === "email") expect(sink.sent[0]!.message.subject).toBe("[Tidepool] Something failed");
    const m = await row(first.messageId!);
    expect(m.dedupeKey).toBe("alert:test_alert:2026-10-20T16");
    expect(m.personId).toBeNull();
    expect(m.status).toBe("sent");
  });
});
