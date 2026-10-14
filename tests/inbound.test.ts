import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { consentEvent, employer, message, suppression } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { liftByStaff, suppress, SuppressionLiftRefused } from "@/server/services/messaging/consent";
import { classifyKeyword, recordInboundText } from "@/server/services/messaging/inbound";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { createApplication, createPerson, loadAdminId, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

const HIRING_NUMBER = "+17632922259";
const NOON = new Date("2026-10-20T16:00:00Z");

let snow: SnowFixture;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  await db.update(employer).set({ smsQuoPhoneNumberId: "PNtest0001", smsEnabled: true }).where(eq(employer.id, employerId));
});

afterAll(async () => {
  await db.update(employer).set({ smsQuoPhoneNumberId: null }).where(eq(employer.id, employerId));
  await sql.end();
});

let counter = 0;
function inbound(from: string, body: string, overrides: Partial<Parameters<typeof recordInboundText>[1]> = {}) {
  counter += 1;
  return recordInboundText(db, {
    providerMessageId: `quo-in-${Date.now()}-${counter}`,
    from,
    to: HIRING_NUMBER,
    body,
    receivedAt: NOON,
    now: NOON,
    ...overrides,
  });
}

describe("keyword classification", () => {
  it("recognises Quo's opt-out words plus REVOKE and OPT OUT, START, UNSTOP and HELP", () => {
    for (const word of ["STOP", "stop", " Stop. ", "STOPALL", "unsubscribe", "Cancel", "END", "quit", "REVOKE", "opt out", "Opt  Out!", "OPTOUT"]) {
      expect(classifyKeyword(word), word).toBe("stop");
    }
    expect(classifyKeyword("START")).toBe("start");
    expect(classifyKeyword("unstop")).toBe("start");
    expect(classifyKeyword("help?")).toBe("help");
    // Anything else waits for a person: a classifier that misses this gives false comfort.
    expect(classifyKeyword("please stop texting me")).toBeNull();
    expect(classifyKeyword("STOP calling, text is fine")).toBeNull();
    expect(classifyKeyword("")).toBeNull();
  });
});

describe("inbound texts", () => {
  it("STOP from a known number writes the message, a suppression and a consent event, and is handled", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const { applicationId } = await createApplication(db, snow, personId);
    const outcome = await inbound(mobile, "STOP");
    expect(outcome.kind).toBe("stop");
    if (outcome.kind !== "stop") return;
    expect(outcome.personId).toBe(personId);

    const [m] = await db.select().from(message).where(eq(message.id, outcome.messageId));
    expect(m!.direction).toBe("inbound");
    expect(m!.status).toBe("received");
    expect(m!.applicationId).toBe(applicationId);
    expect(m!.handledAt).not.toBeNull();
    expect(m!.fromAddress).toBe(mobile);

    const [s] = await db.select().from(suppression).where(and(eq(suppression.address, mobile), eq(suppression.channel, "sms")));
    expect(s!.reason).toBe("stop_keyword");
    expect(s!.messageId).toBe(outcome.messageId);
    expect(s!.liftedAt).toBeNull();

    const [c] = await db.select().from(consentEvent).where(eq(consentEvent.messageId, outcome.messageId));
    expect(c!.action).toBe("opt_out");
    expect(c!.method).toBe("keyword");
    expect(c!.employerId).toBe(employerId);
    expect(c!.applicationId).toBe(applicationId);
  });

  it("a redelivered event is a duplicate and changes nothing", async () => {
    const mobile = nextMobile();
    await createPerson(db, { mobileE164: mobile });
    const first = await inbound(mobile, "STOP", { providerMessageId: `dup-${mobile}` });
    const second = await inbound(mobile, "STOP", { providerMessageId: `dup-${mobile}` });
    expect(first.kind).toBe("stop");
    expect(second.kind).toBe("duplicate");
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(1);
    expect(await db.select().from(message).where(eq(message.fromAddress, mobile))).toHaveLength(1);
  });

  it("START lifts the suppression and records an opt-in by keyword", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    await inbound(mobile, "STOP");
    const outcome = await inbound(mobile, "START", { receivedAt: new Date(NOON.getTime() + 60_000) });
    expect(outcome.kind).toBe("start");
    if (outcome.kind !== "start") return;
    expect(outcome.lifted).toBe(1);
    const [s] = await db.select().from(suppression).where(eq(suppression.address, mobile));
    expect(s!.liftedAt).not.toBeNull();
    expect(s!.liftReason).toBe("START keyword");
    const consents = await db.select().from(consentEvent).where(eq(consentEvent.personId, personId));
    expect(consents.map((c) => c.action)).toEqual(["opt_out", "opt_in_keyword"]);
  });

  it("STOP from an unknown number still suppresses it, with no consent row to write", async () => {
    const mobile = nextMobile();
    const outcome = await inbound(mobile, "stop");
    expect(outcome.kind).toBe("stop");
    if (outcome.kind !== "stop") return;
    expect(outcome.personId).toBeNull();
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(1);
    expect(await db.select().from(consentEvent).where(eq(consentEvent.address, mobile))).toHaveLength(0);
  });

  it("HELP gets the templated reply even without an opt-in, unless the number is suppressed", async () => {
    const mobile = nextMobile();
    const sink = createSinkProviders();
    const outcome = await inbound(mobile, "HELP", { providers: sink });
    expect(outcome.kind).toBe("help");
    if (outcome.kind !== "help") return;
    expect(outcome.personId).toBeNull();
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.message.to).toBe(mobile);
    expect(sink.sent[0]!.message.body).toContain("for help, reach us at 763-292-2259");
    const [reply] = await db.select().from(message).where(eq(message.id, outcome.replyMessageId!));
    expect(reply!.purpose).toBe("help_reply");
    expect(reply!.status).toBe("sent");
    expect(reply!.personId).toBeNull();
    const [m] = await db.select().from(message).where(eq(message.id, outcome.messageId));
    expect(m!.handledAt).not.toBeNull();

    const blocked = nextMobile();
    await inbound(blocked, "STOP");
    const sink2 = createSinkProviders();
    const after = await inbound(blocked, "HELP", { providers: sink2 });
    expect(after.kind).toBe("help");
    expect(sink2.sent).toHaveLength(0);
    if (after.kind === "help") expect((await db.select().from(message).where(eq(message.id, after.replyMessageId!)))[0]!.status).toBe("suppressed");
  });

  it("everything else stays unhandled for a person to read", async () => {
    const mobile = nextMobile();
    const personId = await createPerson(db, { mobileE164: mobile });
    const outcome = await inbound(mobile, "Can I still apply if I only have weekends?");
    expect(outcome.kind).toBe("unhandled");
    if (outcome.kind !== "unhandled") return;
    expect(outcome.personId).toBe(personId);
    const [m] = await db.select().from(message).where(eq(message.id, outcome.messageId));
    expect(m!.handledAt).toBeNull();
    expect(await db.select().from(suppression).where(eq(suppression.address, mobile))).toHaveLength(0);
  });

  it("drops events for a number that is not the hiring number", async () => {
    const mobile = nextMobile();
    const outcome = await inbound(mobile, "STOP", { to: "+16125550199" });
    expect(outcome).toEqual({ kind: "ignored", reason: "unknown_number" });
    expect(await db.select().from(message).where(eq(message.fromAddress, mobile))).toHaveLength(0);
  });
});

describe("staff lifts", () => {
  it("refuses to lift a keyword or carrier suppression but lifts a staff-marked one", async () => {
    const adminId = await loadAdminId(db);
    const keyword = await suppress(db, { channel: "sms", address: nextMobile(), reason: "stop_keyword" });
    await expect(liftByStaff(db, { suppressionId: keyword.id, userId: adminId, reason: "asked" })).rejects.toBeInstanceOf(SuppressionLiftRefused);
    const carrier = await suppress(db, { channel: "sms", address: nextMobile(), reason: "carrier_blocked" });
    await expect(liftByStaff(db, { suppressionId: carrier.id, userId: adminId, reason: "asked" })).rejects.toBeInstanceOf(SuppressionLiftRefused);
    const marked = await suppress(db, { channel: "sms", address: nextMobile(), reason: "staff_marked", createdBy: adminId });
    const lifted = await liftByStaff(db, { suppressionId: marked.id, userId: adminId, reason: "They asked for texts again in person" });
    expect(lifted.liftedAt).not.toBeNull();
    expect(lifted.liftedBy).toBe(adminId);
  });
});
