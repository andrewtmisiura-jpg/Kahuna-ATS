import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, consentEvent, employer, landingConflict, legalTextVersion, message, person, suppression } from "@/db/schema";
import { LAUNCH_ENTRY_CODES, seedPhase1 } from "@/db/seed";
import { resolveEntryCode } from "@/server/services/entry-codes";
import { isPlausibleEmail, landApplicant, LandingError, normalizeUsMobile, suggestEmail, type LandingInput } from "@/server/services/landing";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { processMessages } from "@/server/services/messaging/send";
import { createPerson, loadEmployer, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let employerId: string;
let smsConsentId: string;
let entryCodeId: string;
let emailCounter = 0;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  await db.update(employer).set({ smsQuoPhoneNumberId: "PNtest0001", smsEnabled: true }).where(eq(employer.id, employerId));
  const [consent] = await db.select({ id: legalTextVersion.id }).from(legalTextVersion).where(eq(legalTextVersion.kind, "sms_consent"));
  smsConsentId = consent!.id;
  const code = await resolveEntryCode(db, LAUNCH_ENTRY_CODES.snowRoleQr);
  if (code.status !== "open") throw new Error("launch code should resolve");
  entryCodeId = code.entryCode.id;
});

afterAll(async () => {
  await db.update(employer).set({ smsQuoPhoneNumberId: null }).where(eq(employer.id, employerId));
  await sql.end();
});

function newEmail() {
  emailCounter += 1;
  return `Landing.${Date.now()}.${emailCounter}@Example.test`;
}

function input(overrides: Partial<LandingInput> = {}): LandingInput {
  return {
    openingId: snow.openingId,
    entryCodeId,
    entryChannel: "role_qr",
    firstName: "Ana",
    lastName: "Lind",
    mobile: nextMobile(),
    email: newEmail(),
    textConsent: { checked: true, legalTextVersionId: smsConsentId },
    ip: "203.0.113.9",
    userAgent: "test",
    ...overrides,
  };
}

async function applicationsOf(personId: string) {
  return db
    .select()
    .from(application)
    .where(and(eq(application.personId, personId), eq(application.openingId, snow.openingId)));
}

describe("phone and email helpers", () => {
  it("normalizes US mobiles typed any common way and rejects the rest", () => {
    for (const typed of ["(612) 555-0123", "612-555-0123", "6125550123", "+1 612 555 0123", "1 (612) 555 0123"]) {
      expect(normalizeUsMobile(typed), typed).toBe("+16125550123");
    }
    expect(normalizeUsMobile("555-0123")).toBeNull();
    expect(normalizeUsMobile("612-155-0123")).toBeNull();
    expect(normalizeUsMobile("+44 20 7946 0958")).toBeNull();
    expect(normalizeUsMobile("")).toBeNull();
  });

  it("suggests a fix for a common domain typo and stays quiet otherwise", () => {
    expect(suggestEmail("ana@gmal.com")).toBe("ana@gmail.com");
    expect(suggestEmail("Ana@Gmail.con")).toBe("ana@gmail.com");
    expect(suggestEmail("ana@yaho.com")).toBe("ana@yahoo.com");
    expect(suggestEmail("ana@hotmail.co")).toBe("ana@hotmail.com");
    expect(suggestEmail("ana@gmail.com")).toBeNull();
    expect(suggestEmail("ana@kahunawindowcleaning.com")).toBeNull();
    expect(suggestEmail("nonsense")).toBeNull();
    expect(isPlausibleEmail("ana@example.test")).toBe(true);
    expect(isPlausibleEmail("ana@")).toBe(false);
  });
});

describe("landing", () => {
  it("creates the person and application, records the opt-in and queues the link by text and email", async () => {
    const data = input();
    const result = await landApplicant(db, data);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.newPerson).toBe(true);
    expect(result.textsBlocked).toBe(false);

    const [who] = await db.select().from(person).where(eq(person.id, result.personId));
    expect(who!.mobileE164).toBe(normalizeUsMobile(data.mobile));
    expect(who!.email).toBe(data.email);
    expect(who!.emailNormalized).toBe(data.email.toLowerCase());
    expect(who!.firstName).toBe("Ana");

    const [app] = await db.select().from(application).where(eq(application.id, result.applicationId));
    expect(app!.formVersionId).toBe(snow.formVersionId);
    expect(app!.entryCodeId).toBe(entryCodeId);
    expect(app!.entryChannel).toBe("role_qr");
    expect(app!.origin).toBe("landing");

    const consents = await db.select().from(consentEvent).where(eq(consentEvent.applicationId, result.applicationId));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      action: "opt_in",
      method: "web_form",
      legalTextVersionId: smsConsentId,
      checkboxValue: true,
      address: who!.mobileE164,
      employerId,
      entryCodeId,
      ip: "203.0.113.9",
    });

    expect(result.queued).toHaveLength(2);
    const sink = createSinkProviders();
    const summary = await processMessages(db, result.queued, sink);
    expect(summary.sent).toHaveLength(2);
    expect(sink.sent.map((s) => s.channel).sort()).toEqual(["email", "sms"]);
    const rows = await db.select().from(message).where(eq(message.applicationId, result.applicationId));
    expect(rows.every((m) => m.purpose === "resume_link")).toBe(true);
  });

  it("records a declined box and queues the email only", async () => {
    const result = await landApplicant(db, input({ textConsent: { checked: false, legalTextVersionId: smsConsentId } }));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const [consent] = await db.select().from(consentEvent).where(eq(consentEvent.applicationId, result.applicationId));
    expect(consent!.action).toBe("declined");
    expect(consent!.checkboxValue).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect((await db.select().from(message).where(eq(message.id, result.queued[0]!)))[0]!.channel).toBe("email");
  });

  it("resends the link to the details on file when the same person lands again, changing nothing", async () => {
    const data = input();
    const first = await landApplicant(db, data);
    if (first.outcome !== "created") throw new Error("expected created");
    const again = await landApplicant(db, input({ mobile: data.mobile, email: data.email.toUpperCase(), firstName: "Anna", lastName: "Other" }));
    expect(again.outcome).toBe("resent");
    if (again.outcome !== "resent") return;
    expect(again.applicationId).toBe(first.applicationId);
    expect(await applicationsOf(first.personId)).toHaveLength(1);
    const [who] = await db.select().from(person).where(eq(person.id, first.personId));
    expect(who!.firstName).toBe("Ana");
    expect(who!.lastName).toBe("Lind");
    const rows = await db.select().from(message).where(eq(message.applicationId, first.applicationId));
    expect(rows.filter((m) => m.purpose === "link_recovery")).toHaveLength(2);
    expect(rows.every((m) => m.toAddress === data.email || m.toAddress === who!.mobileE164)).toBe(true);
  });

  it("mobile on file with a different email is a conflict: no application for the typist, link to the person on file", async () => {
    const data = input();
    const first = await landApplicant(db, data);
    if (first.outcome !== "created") throw new Error("expected created");
    const typedEmail = newEmail();
    const result = await landApplicant(db, input({ mobile: data.mobile, email: typedEmail }));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") return;
    expect(result.applicationId).toBe(first.applicationId);
    const [conflict] = await db.select().from(landingConflict).where(eq(landingConflict.id, result.conflictId));
    expect(conflict!.matchedPersonIds).toEqual([first.personId]);
    expect(conflict!.typedEmail).toBe(typedEmail);
    expect(conflict!.typedMobileE164).toBe(normalizeUsMobile(data.mobile));
    expect(conflict!.resolvedAt).toBeNull();
    expect(await applicationsOf(first.personId)).toHaveLength(1);
    expect(await db.select().from(person).where(eq(person.emailNormalized, typedEmail.toLowerCase()))).toHaveLength(0);
    // The link went to the details on file, never to the typed email.
    const sent = await db.select().from(message).where(eq(message.applicationId, first.applicationId));
    expect(sent.some((m) => m.toAddress === typedEmail)).toBe(false);
    expect(result.queued.length).toBeGreaterThan(0);
  });

  it("email on file with a new mobile is a conflict with no link", async () => {
    const data = input();
    const first = await landApplicant(db, data);
    if (first.outcome !== "created") throw new Error("expected created");
    const result = await landApplicant(db, input({ email: data.email }));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") return;
    expect(result.applicationId).toBeNull();
    expect(result.queued).toEqual([]);
    const [conflict] = await db.select().from(landingConflict).where(eq(landingConflict.id, result.conflictId));
    expect(conflict!.matchedPersonIds).toEqual([first.personId]);
  });

  it("mobile of one person and email of another names both", async () => {
    const a = await landApplicant(db, input());
    const b = await landApplicant(db, input());
    if (a.outcome !== "created" || b.outcome !== "created") throw new Error("expected created");
    const [personA] = await db.select().from(person).where(eq(person.id, a.personId));
    const [personB] = await db.select().from(person).where(eq(person.id, b.personId));
    const result = await landApplicant(db, input({ mobile: personA!.mobileE164!, email: personB!.email! }));
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") return;
    const [conflict] = await db.select().from(landingConflict).where(eq(landingConflict.id, result.conflictId));
    expect([...conflict!.matchedPersonIds].sort()).toEqual([a.personId, b.personId].sort());
  });

  it("a shared mobile matches by email only, and creates a new person on the shared number otherwise", async () => {
    const mobile = nextMobile();
    const sharer = await createPerson(db, { mobileE164: mobile, sharedMobile: true, email: "shared.one@example.test", emailNormalized: "shared.one@example.test" });
    const partner = await landApplicant(db, input({ mobile, email: newEmail() }));
    expect(partner.outcome).toBe("created");
    if (partner.outcome !== "created") return;
    expect(partner.personId).not.toBe(sharer);
    const [who] = await db.select().from(person).where(eq(person.id, partner.personId));
    expect(who!.sharedMobile).toBe(true);
    expect(who!.mobileE164).toBe(mobile);

    const byEmail = await landApplicant(db, input({ mobile, email: "Shared.One@example.test" }));
    expect(byEmail.outcome).toBe("created");
    if (byEmail.outcome === "created") expect(byEmail.personId).toBe(sharer);
  });

  it("follows a merged person to its root", async () => {
    const rootEmail = newEmail();
    const root = await landApplicant(db, input({ email: rootEmail }));
    if (root.outcome !== "created") throw new Error("expected created");
    const oldMobile = nextMobile();
    await createPerson(db, { mobileE164: oldMobile, mergedIntoPersonId: root.personId });
    const result = await landApplicant(db, input({ mobile: oldMobile, email: rootEmail }));
    expect(result.outcome).toBe("resent");
    if (result.outcome === "resent") expect(result.personId).toBe(root.personId);
  });

  it("keeps a STOP suppression in place after a web opt-in and tells the page", async () => {
    const mobile = nextMobile();
    await db.insert(suppression).values({ id: crypto.randomUUID(), channel: "sms", address: mobile, reason: "stop_keyword" });
    const result = await landApplicant(db, input({ mobile }));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.textsBlocked).toBe(true);
    const [s] = await db.select().from(suppression).where(eq(suppression.address, mobile));
    expect(s!.liftedAt).toBeNull();
    const sink = createSinkProviders();
    const summary = await processMessages(db, result.queued, sink);
    expect(summary.sent).toHaveLength(1);
    expect(sink.sent[0]!.channel).toBe("email");
  });

  it("rejects bad input, a closed opening and a foreign consent text", async () => {
    await expect(landApplicant(db, input({ mobile: "555-0123" }))).rejects.toMatchObject({ code: "invalid_mobile" });
    await expect(landApplicant(db, input({ email: "nope" }))).rejects.toMatchObject({ code: "invalid_email" });
    await expect(landApplicant(db, input({ firstName: " " }))).rejects.toMatchObject({ code: "name_required" });
    await expect(landApplicant(db, input({ textConsent: { checked: true, legalTextVersionId: crypto.randomUUID() } }))).rejects.toBeInstanceOf(
      LandingError,
    );
    const [windowOpening] = await sql<{ id: string }[]>`select id from opening where key = 'window-2027'`;
    await expect(landApplicant(db, input({ openingId: windowOpening!.id }))).rejects.toMatchObject({ code: "opening_not_open" });
  });

  it("two simultaneous first landings from one phone end in one person and one application", async () => {
    const data = input();
    const results = await Promise.all([landApplicant(db, data), landApplicant(db, data)]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["created", "resent"]);
    const created = results.find((r) => r.outcome === "created");
    if (!created || created.outcome !== "created") return;
    expect(await applicationsOf(created.personId)).toHaveLength(1);
    expect(await db.select().from(person).where(eq(person.mobileE164, normalizeUsMobile(data.mobile)!))).toHaveLength(1);
  });
});
