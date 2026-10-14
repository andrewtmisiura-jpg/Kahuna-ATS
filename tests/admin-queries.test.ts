import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { answer, application, groupSession, hireStint, landingConflict, message, opening, question, questionVersion, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import {
  attentionCounts,
  defaultOpening,
  listApplicationIds,
  listApplications,
  listCounts,
  listFilterOptions,
  listFilterParams,
  listOpenings,
  loadProfile,
  neighbors,
  parseListFilters,
  type ListFilters,
} from "@/server/services/applications/queries";
import { createApplication, transition } from "@/server/services/applications/transition";
import { addDays, centralDate } from "@/server/services/time";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// The list view's queries against a closed test opening of the snow role, so the
// counts are not disturbed by the applications other test files create.

let snow: SnowFixture;
let stages: Record<string, string>;
let adminId: string;
let staff: { type: "staff"; userId: string };
let openingId: string;
let sessionId: string;
let codeId: string;
const ids: Record<string, string> = {};
const people: Record<string, string> = {};

const applicant = { type: "applicant" } as const;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function startApplication(name: string, options: { startedAt?: Date; entryCodeId?: string | null; source?: "indeed" | "referral" | null; session?: boolean; email?: string; mobile?: string } = {}) {
  const [first, last] = name.split(" ");
  const personId = await createPerson(db, {
    firstName: first,
    lastName: last,
    email: options.email,
    emailNormalized: options.email?.toLowerCase(),
    ...(options.mobile ? { mobileE164: options.mobile } : {}),
  });
  const { applicationId } = await createApplication(db, {
    personId,
    openingId,
    origin: "staff_created",
    entryCodeId: options.entryCodeId ?? null,
    entryChannel: "staff_entered",
    scannedSessionId: options.session ? sessionId : null,
    source: options.source ?? null,
    actor: applicant,
    occurredAt: options.startedAt,
  });
  people[name] = personId;
  ids[name] = applicationId;
  return { applicationId, personId };
}

async function submit(applicationId: string, at?: Date) {
  await transition(db, { action: "submit", applicationId, actor: applicant, occurredAt: at });
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = { type: "staff", userId: adminId };

  openingId = uuidv7();
  await db.insert(opening).values({ id: openingId, roleId: snow.roleId, key: "snow-admin-test", name: "Snow admin test", status: "closed" });
  sessionId = uuidv7();
  await db.insert(groupSession).values({
    id: sessionId,
    openingId,
    startsAt: new Date("2026-10-20T23:00:00Z"),
    locationName: "Golden Valley shop",
    status: "scheduled",
    createdBy: adminId,
  });
  const [code] = await sql<{ id: string }[]>`select id from entry_code where code = 'SNW26QR'`;
  codeId = code!.id;

  // Started only, still active: counts as in progress.
  await startApplication("Ingrid Started");
  // Started 30 days ago and never touched: dropped off, and outside a recent date range.
  const olga = await startApplication("Olga Old", { startedAt: daysAgo(30) });
  await db.update(application).set({ lastActivityAt: daysAgo(30) }).where(eq(application.id, olga.applicationId));
  // Submitted, from Indeed through the role QR, with a session.
  const alice = await startApplication("Alice Winter", { entryCodeId: codeId, source: "indeed", session: true, email: "alice.winter@example.test", mobile: "+16125550123" });
  await submit(alice.applicationId);
  // Submitted, moved to Reviewed, on hold.
  const bob = await startApplication("Bob Holder", { source: "referral" });
  await submit(bob.applicationId);
  await transition(db, { action: "move", applicationId: bob.applicationId, toStageId: stages.reviewed!, actor: staff });
  await transition(db, { action: "hold", applicationId: bob.applicationId, actor: staff });
  // Submitted then disqualified.
  const carl = await startApplication("Carl Closed");
  await submit(carl.applicationId);
  const availability = await loadOption(db, "disqualify_reason", "availability_conflict");
  await transition(db, { action: "close", applicationId: carl.applicationId, outcome: "disqualified", reasonOptionId: availability, actor: staff });
  // Submitted with an attention answer: not 18.
  const dana = await startApplication("Dana Young");
  const [age] = await db
    .select({ id: questionVersion.id })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(question.roleId, snow.roleId), eq(question.key, "age_18_plus")));
  await db.insert(answer).values({ id: uuidv7(), applicationId: dana.applicationId, questionVersionId: age!.id, valueBool: false });
  await submit(dana.applicationId);
  // Submitted and hired on the spot.
  const evan = await startApplication("Evan Hired");
  await submit(evan.applicationId);
  await transition(db, { action: "move", applicationId: evan.applicationId, toStageId: stages.hired!, actor: staff, hire: { isTemporary: true } });
  // Returning: a prior stint marked not rehire eligible.
  const fay = await startApplication("Fay Returning");
  const [snowRole] = await db.select({ employerId: role.employerId }).from(role).where(eq(role.id, snow.roleId));
  await db.insert(hireStint).values({
    id: uuidv7(),
    personId: fay.personId,
    applicationId: null,
    origin: "historical_import",
    employerId: snowRole!.employerId,
    roleId: snow.roleId,
    openingId: null,
    outcome: "separated",
    separationType: "involuntary",
    leaveReasonOptionId: await loadOption(db, "leave_reason", "attendance"),
    endOn: "2026-03-01",
    rehireEligible: false,
  });
  await submit(fay.applicationId);
  // A landing conflict naming Alice, and an unhandled text from her.
  await db.insert(landingConflict).values({
    id: uuidv7(),
    openingId,
    typedFirstName: "Alice",
    typedLastName: "Winter",
    typedMobileE164: "+16125550123",
    typedEmail: "other@example.test",
    matchedPersonIds: [alice.personId],
  });
  await db.insert(message).values({
    id: uuidv7(),
    direction: "inbound",
    channel: "sms",
    personId: alice.personId,
    applicationId: alice.applicationId,
    toAddress: "+17632922259",
    fromAddress: "+16125550123",
    body: "Can I come Tuesday instead?",
    status: "received",
    provider: "quo",
    providerMessageId: `quo-admin-${alice.applicationId}`,
    triggeredByType: "applicant",
  });
});

afterAll(async () => {
  await sql.end();
});

function filters(extra: Partial<ListFilters> = {}): ListFilters {
  return { openingId, ...extra };
}

async function names(extra: Partial<ListFilters> = {}, role: "admin" | "viewer" = "admin") {
  const page = await listApplications(db, filters(extra), role);
  return page.rows.map((row) => `${row.firstName} ${row.lastName}`).sort();
}

describe("openings and filter parsing", () => {
  it("lists openings and opens on the open one by default", async () => {
    const openings = await listOpenings(db);
    expect(openings.some((o) => o.id === openingId)).toBe(true);
    expect(defaultOpening(openings)?.status).toBe("open");
    expect(defaultOpening(openings, openingId)?.id).toBe(openingId);
  });

  it("parses the URL and drops unknown values", () => {
    const parsed = parseListFilters({ status: "closed", source: "bogus", from: "2026-10-01", to: "nope", hold: "1", q: " Ali ", page: "2" }, openingId);
    expect(parsed).toMatchObject({ openingId, status: "closed", source: undefined, from: "2026-10-01", to: undefined, onHold: true, search: "Ali", page: 2 });
    const params = listFilterParams(parsed);
    expect(params.get("status")).toBe("closed");
    expect(params.get("hold")).toBe("1");
    expect(params.get("page")).toBe("2");
    expect(params.has("source")).toBe(false);
  });

  it("offers the role's stages, the entry codes and the opening's sessions", async () => {
    const openings = await listOpenings(db);
    const options = await listFilterOptions(db, openings.find((o) => o.id === openingId)!);
    expect(options.stages.map((s) => s.key)).toContain("reviewed");
    expect(options.entryCodes.some((c) => c.code === "SNW26QR")).toBe(true);
    expect(options.sessions).toHaveLength(1);
    expect(options.sessions[0]!.label).toContain("Golden Valley shop");
  });
});

describe("counts", () => {
  it("counts started, in progress, submitted and the rate, overall and per entry code", async () => {
    const counts = await listCounts(db, filters());
    expect(counts.total).toEqual({ started: 8, inProgress: 1, submitted: 6, submitRate: 6 / 8 });
    const qr = counts.byEntryCode.find((c) => c.code === "SNW26QR");
    expect(qr).toMatchObject({ started: 1, submitted: 1, inProgress: 0, submitRate: 1 });
    const none = counts.byEntryCode.find((c) => c.entryCodeId === null);
    expect(none).toMatchObject({ label: "No entry code", started: 7, submitted: 5 });
  });

  it("applies the date range to the counts", async () => {
    const counts = await listCounts(db, filters({ from: addDays(centralDate(new Date()), -1) }));
    expect(counts.total.started).toBe(7);
  });

  it("builds the attention strip", async () => {
    const strip = await attentionCounts(db, openingId);
    expect(strip.unhandledTexts).toBeGreaterThanOrEqual(1);
    expect(strip.openConflicts).toBe(1);
    expect(strip.notRehireEligible).toBe(1);
  });
});

describe("rows and filters", () => {
  it("leaves started applications out unless the status filter asks", async () => {
    expect(await names()).toEqual(["Alice Winter", "Bob Holder", "Carl Closed", "Dana Young", "Evan Hired", "Fay Returning"]);
    expect(await names({ status: "started" })).toEqual(["Ingrid Started", "Olga Old"]);
    expect(await names({ status: "all" })).toHaveLength(8);
  });

  it("filters by status", async () => {
    expect(await names({ status: "open" })).toEqual(["Alice Winter", "Bob Holder", "Dana Young", "Fay Returning"]);
    expect(await names({ status: "hired" })).toEqual(["Evan Hired"]);
    expect(await names({ status: "closed" })).toEqual(["Carl Closed"]);
  });

  it("filters by stage, source, entry code, session, hold, attention and conflicts", async () => {
    expect(await names({ stageId: stages.reviewed })).toEqual(["Bob Holder"]);
    expect(await names({ source: "indeed" })).toEqual(["Alice Winter"]);
    expect(await names({ source: "none" })).toEqual(["Carl Closed", "Dana Young", "Evan Hired", "Fay Returning"]);
    expect(await names({ entryCodeId: codeId })).toEqual(["Alice Winter"]);
    expect(await names({ entryCodeId: "none" })).toHaveLength(5);
    expect(await names({ sessionId })).toEqual(["Alice Winter"]);
    expect(await names({ sessionId: "none" })).toHaveLength(5);
    expect(await names({ onHold: true })).toEqual(["Bob Holder"]);
    expect(await names({ attention: true })).toEqual(["Dana Young"]);
    expect(await names({ conflicts: true })).toEqual(["Alice Winter"]);
  });

  it("filters by date range on the start time", async () => {
    const today = centralDate(new Date());
    expect(await names({ status: "all", to: addDays(today, -2) })).toEqual(["Olga Old"]);
    expect(await names({ status: "all", from: addDays(today, -1) })).toHaveLength(7);
  });

  it("searches by name, mobile or email", async () => {
    expect(await names({ search: "winter" })).toEqual(["Alice Winter"]);
    expect(await names({ search: "alice w" })).toEqual(["Alice Winter"]);
    expect(await names({ search: "(612) 555-0123" })).toEqual(["Alice Winter"]);
    expect(await names({ search: "alice.winter@" })).toEqual(["Alice Winter"]);
    expect(await names({ search: "nobody" })).toEqual([]);
  });

  it("marks returning people, attention answers, unhandled texts and the hold", async () => {
    const page = await listApplications(db, filters(), "admin");
    const row = (name: string) => page.rows.find((r) => `${r.firstName} ${r.lastName}` === name)!;
    expect(row("Fay Returning").returning).toBe("not_rehire_eligible");
    expect(row("Alice Winter").returning).toBe("none");
    expect(row("Dana Young").attention).toEqual([{ prompt: "Are you 18 or older?", value: "No" }]);
    expect(row("Alice Winter").unhandledTexts).toBe(1);
    expect(row("Alice Winter").mobile).toBe("+16125550123");
    expect(row("Alice Winter").sessionLabel).toContain("Golden Valley shop");
    expect(row("Bob Holder").onHold).toBe(true);
    expect(row("Carl Closed").closedReasonLabel).toBe("Availability doesn't fit");
    expect(page.total).toBe(6);
    expect(page.pageCount).toBe(1);
  });

  it("gives a Viewer rows without contact details and a name-only search", async () => {
    const page = await listApplications(db, filters(), "viewer");
    expect(page.rows.every((r) => r.mobile === null && r.email === null)).toBe(true);
    expect(await names({ search: "612" }, "viewer")).toEqual([]);
    expect(await names({ search: "Winter" }, "viewer")).toEqual(["Alice Winter"]);
  });

  it("orders newest first and finds the neighbours of a row", async () => {
    const ordered = await listApplicationIds(db, filters(), "admin");
    expect(ordered).toHaveLength(6);
    expect(ordered[0]).toBe(ids["Fay Returning"]);
    const around = neighbors(ordered, ids["Dana Young"]!);
    expect(around.previous).toBe(ids["Evan Hired"]);
    expect(around.next).toBe(ids["Carl Closed"]);
    expect(neighbors(ordered, "not-in-list")).toEqual({ previous: null, next: null });
  });
});

describe("profile", () => {
  it("loads the answers with their version wording, the history and the records", async () => {
    const profile = await loadProfile(db, ids["Dana Young"]!, "admin");
    expect(profile).not.toBeNull();
    expect(profile!.application.stageName).toBe("Submitted");
    expect(profile!.application.formVersion).toBe(1);
    const age = profile!.answers.find((a) => a.questionKey === "age_18_plus")!;
    expect(age).toMatchObject({ prompt: "Are you 18 or older?", version: 1, value: "No", attention: true });
    expect(profile!.answers.find((a) => a.questionKey === "equipment")!.value).toBeNull();
    expect(profile!.events.map((e) => e.kind)).toEqual(["created", "submitted"]);
    expect(profile!.stages.map((s) => s.key)).toContain("hired");
    expect(profile!.picklists.disqualify.some((o) => o.fcraAdverse)).toBe(true);
  });

  it("shows the returning strip, the conflict and the text thread for staff", async () => {
    const fay = await loadProfile(db, ids["Fay Returning"]!, "admin");
    expect(fay!.returning.notRehireEligible).toBe(true);
    expect(fay!.returning.stints[0]).toMatchObject({ outcome: "separated", leaveReasonLabel: "Attendance", rehireEligible: false });

    const alice = await loadProfile(db, ids["Alice Winter"]!, "hiring_manager");
    expect(alice!.conflicts).toHaveLength(1);
    expect(alice!.conflicts[0]!.typedEmail).toBe("other@example.test");
    expect(alice!.messages).toHaveLength(1);
    expect(alice!.messages[0]!.body).toContain("Tuesday");
    expect(alice!.texting).toEqual({ optedIn: false, suppression: null });
    expect(alice!.person.mobile).toBe("+16125550123");

    const evan = await loadProfile(db, ids["Evan Hired"]!, "admin");
    expect(evan!.stint?.isTemporary).toBe(true);
    expect(evan!.application.status).toBe("hired");
  });

  it("gives a Viewer no contact details, message bodies, consent, checks or restricted notes", async () => {
    const alice = await loadProfile(db, ids["Alice Winter"]!, "viewer");
    expect(alice!.person.mobile).toBeNull();
    expect(alice!.person.email).toBeNull();
    expect(alice!.texting).toBeNull();
    expect(alice!.conflicts).toEqual([]);
    expect(alice!.consents).toEqual([]);
    expect(alice!.checks).toEqual([]);
    expect(alice!.messages[0]!.body).toBeNull();
    expect(alice!.messages[0]!.address).toBeNull();
  });

  it("returns null for a deleted or unknown application", async () => {
    expect(await loadProfile(db, uuidv7(), "admin")).toBeNull();
    const { applicationId } = await startApplication("Gone Deleted");
    await db.update(application).set({ deletedAt: new Date() }).where(eq(application.id, applicationId));
    expect(await loadProfile(db, applicationId, "admin")).toBeNull();
    expect(await names({ status: "all" })).not.toContain("Gone Deleted");
  });
});
