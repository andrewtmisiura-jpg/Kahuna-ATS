import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { employer, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { recordInboundText } from "@/server/services/messaging/inbound";
import {
  alertUnhandledInbound,
  businessDaysUnhandled,
  countUnhandledInbound,
  INBOX_ALERT_PREFIX,
  INBOX_REALERT_PREFIX,
  listUnhandledInbound,
  markHandled,
} from "@/server/services/messaging/inbox";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { createApplication, createPerson, loadAdminId, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

const HIRING_NUMBER = "+17632922259";
const HIRING_EMAIL = "hiring@example.test";
// Thursday Oct 15, 2026, 11:00 CDT.
const THU = new Date("2026-10-15T16:00:00Z");
const FRI = new Date("2026-10-16T16:00:00Z");
const MON = new Date("2026-10-19T16:00:00Z");

let snow: SnowFixture;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  await db.update(employer).set({ replyToAddress: HIRING_EMAIL }).where(eq(employer.id, employerId));
});

afterAll(async () => {
  await db.update(employer).set({ replyToAddress: null }).where(eq(employer.id, employerId));
  await sql.end();
});

let seq = 0;
async function textFrom(mobile: string, body: string, receivedAt: Date) {
  seq += 1;
  const outcome = await recordInboundText(db, { providerMessageId: `inbox-${Date.now()}-${seq}`, from: mobile, to: HIRING_NUMBER, body, receivedAt, now: receivedAt });
  if (outcome.kind !== "unhandled") throw new Error(`expected an unhandled text, got ${outcome.kind}`);
  return outcome.messageId;
}

async function alertRow(prefix: string, messageId: string) {
  const [row] = await db.select().from(message).where(eq(message.dedupeKey, `${prefix}${messageId}`));
  return row ?? null;
}

describe("the inbox", () => {
  it("counts business days unhandled on the Central calendar", () => {
    expect(businessDaysUnhandled(THU, FRI)).toBe(1);
    expect(businessDaysUnhandled(THU, MON)).toBe(2);
    expect(businessDaysUnhandled(THU, THU)).toBe(0);
    // Saturday and Sunday do not count.
    expect(businessDaysUnhandled(FRI, MON)).toBe(1);
  });

  it("emails hiring@ once per unhandled text, naming the applicant and linking the profile", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile, firstName: "Jordan", lastName: "Lee" });
    const { applicationId } = await createApplication(db, snow, personId);
    const messageId = await textFrom(mobile, "Can I start next week?", THU);
    const sink = createSinkProviders();

    const first = await alertUnhandledInbound(db, { now: FRI, providers: sink });
    expect(first.recipient).toBe(HIRING_EMAIL);
    expect(first.alerted).toContain(messageId);
    expect(first.realerted).not.toContain(messageId);
    const alert = await alertRow(INBOX_ALERT_PREFIX, messageId);
    expect(alert).toMatchObject({ channel: "email", toAddress: HIRING_EMAIL, status: "sent", personId: null, applicationId: null });
    expect(alert!.subject).toBe("New text from Jordan Lee");
    expect(alert!.body).toContain('"Can I start next week?"');
    expect(alert!.body).toContain(`/admin/applicants/${applicationId}`);
    expect(alert!.body).not.toContain(mobile);
    const sent = sink.sent.find((s) => s.message.messageId === alert!.id);
    expect(sent?.message.to).toBe(HIRING_EMAIL);

    const second = await alertUnhandledInbound(db, { now: new Date(FRI.getTime() + 5 * 60_000), providers: sink });
    expect(second.alerted).not.toContain(messageId);
    expect(second.realerted).not.toContain(messageId);
  });

  it("alerts again after two business days unhandled, once, and stops once the text is handled", async () => {
    const mobile = nextMobile();
    await createPerson(db, { mobileE164: mobile, firstName: "Sam", lastName: "Ortiz" });
    const messageId = await textFrom(mobile, "Still waiting to hear back", THU);
    const sink = createSinkProviders();

    await alertUnhandledInbound(db, { now: FRI, providers: sink });
    expect(await alertRow(INBOX_REALERT_PREFIX, messageId)).toBeNull();

    const monday = await alertUnhandledInbound(db, { now: MON, providers: sink });
    expect(monday.realerted).toContain(messageId);
    const realert = await alertRow(INBOX_REALERT_PREFIX, messageId);
    expect(realert!.subject).toBe("Still unhandled: text from Sam Ortiz (2 business days)");
    expect(realert!.status).toBe("sent");

    const tuesday = await alertUnhandledInbound(db, { now: new Date(MON.getTime() + 86_400_000), providers: sink });
    expect(tuesday.realerted).not.toContain(messageId);
    expect(tuesday.alerted).not.toContain(messageId);
  });

  it("an unknown number is described by its last four digits and linked to the list", async () => {
    const mobile = nextMobile();
    const messageId = await textFrom(mobile, "who is this", THU);
    await alertUnhandledInbound(db, { now: FRI });
    const alert = await alertRow(INBOX_ALERT_PREFIX, messageId);
    expect(alert!.subject).toBe(`New text from A number not on file (ending in ${mobile.slice(-4)})`);
    expect(alert!.body).toContain("/admin/applicants\n");
    expect(alert!.body).not.toContain(`/admin/applicants/`);
    // Without providers the alert is queued for the cron's sender.
    expect(alert!.status).toBe("queued");
  });

  it("lists and counts unhandled texts and marks one handled exactly once", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile, firstName: "Pat", lastName: "Quinn" });
    const messageId = await textFrom(mobile, "Thanks!", THU);
    const adminId = await loadAdminId(db);

    const before = await countUnhandledInbound(db);
    const listed = (await listUnhandledInbound(db)).find((item) => item.messageId === messageId);
    expect(listed).toMatchObject({ body: "Thanks!", personId, firstName: "Pat", lastName: "Quinn", fromAddress: mobile });

    expect(await markHandled(db, messageId, adminId, FRI)).toBe(true);
    expect(await markHandled(db, messageId, adminId, FRI)).toBe(false);
    expect(await countUnhandledInbound(db)).toBe(before - 1);
    expect((await listUnhandledInbound(db)).find((item) => item.messageId === messageId)).toBeUndefined();
    const [row] = await db.select().from(message).where(eq(message.id, messageId));
    expect(row!.handledAt).toEqual(FRI);
    expect(row!.handledBy).toBe(adminId);

    // A handled text is never alerted.
    const summary = await alertUnhandledInbound(db, { now: MON });
    expect(summary.alerted).not.toContain(messageId);
  });
});
