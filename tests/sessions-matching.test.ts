import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, attendee, auditLog, legalTextVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { setGroupInterviewArrival } from "@/server/services/applications/details";
import { landApplicant } from "@/server/services/landing";
import { addAttendee, checkIn, removeAttendee, updateAttendee } from "@/server/services/sessions/attendees";
import { SessionError, type SessionStaff } from "@/server/services/sessions/errors";
import {
  arrivalForCheckIn,
  confirmMatch,
  dismissSuggestion,
  matchApplicationByPhone,
  matchSessionByPhone,
  unmatchAttendee,
} from "@/server/services/sessions/matching";
import { loadApplicationAttendance, loadSessionAttendees } from "@/server/services/sessions/queries";
import { loadAdminId, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { auditActions, createApplicant, createSessionAt, latestAudit, loadWindowOpening, typed, uniqueLastName } from "./helpers/sessions";

// Matching attendees to applications (services/sessions/matching.ts): an exact mobile
// links on its own, a name only suggests, nothing links across openings, staff can
// unmatch, an application made after the session is matched when the session page
// loads (or at once, from the landing form), and a door check-in records arrival.

let snow: SnowFixture;
let adminId: string;
let staff: SessionStaff;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
  staff = { userId: adminId, role: "admin" };
});

afterAll(async () => {
  await sql.end();
});

async function attendeeRow(id: string) {
  const [row] = await db.select().from(attendee).where(eq(attendee.id, id));
  return row!;
}

async function applicationRow(id: string) {
  const [row] = await db.select().from(application).where(eq(application.id, id));
  return row!;
}

async function expectSessionError(run: Promise<unknown>, code: SessionError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof SessionError && error.code === code);
}

describe("exact mobile matches", () => {
  it("links a sheet row by phone at once and attributes the application, but sets no arrival", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const pat = await createApplicant(db, snow, { firstName: "Pat" });

    const added = await addAttendee(db, { sessionId, staff, nameAsWritten: "Patty Q.", mobile: typed(pat.mobile), source: "paper_sheet" });
    expect(added.matchedApplicationId).toBe(pat.applicationId);

    const row = await attendeeRow(added.attendeeId);
    expect(row).toMatchObject({
      applicationId: pat.applicationId,
      personId: pat.personId,
      matchMethod: "phone_match",
      matchedBy: null,
      mobileE164: pat.mobile,
      source: "paper_sheet",
    });
    expect(row.matchedAt).not.toBeNull();

    const app = await applicationRow(pat.applicationId);
    expect(app).toMatchObject({ attributedSessionId: sessionId, attributionMethod: "phone_match", groupInterviewArrival: null });

    expect(await auditActions(db, added.attendeeId)).toEqual(["attendee.add", "attendee.match"]);
    const add = await latestAudit(db, added.attendeeId, "attendee.add");
    expect(add).toMatchObject({ actorType: "staff", actorUserId: adminId });
    // Contact details never reach the audit log.
    expect(JSON.stringify(add!.changes)).not.toContain(pat.mobile.slice(2));
    expect(JSON.stringify(add!.changes)).not.toContain("Patty");
    const match = await latestAudit(db, added.attendeeId, "attendee.match");
    expect(match).toMatchObject({ actorType: "system", applicationId: pat.applicationId });
    const attribution = await latestAudit(db, pat.applicationId, "application.session_attribution");
    expect(attribution!.changes).toMatchObject({ attributedSessionId: { from: null, to: sessionId }, attendeeId: added.attendeeId });
  });

  it("keeps an attribution the application already has and links only one row per application per session", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const other = await createSessionAt(db, snow.openingId, adminId);
    const sam = await createApplicant(db, snow);
    await db.update(application).set({ attributedSessionId: other, attributionMethod: "scanned_session" }).where(eq(application.id, sam.applicationId));

    const first = await addAttendee(db, { sessionId, staff, nameAsWritten: "Sam", mobile: sam.mobile, source: "paper_sheet" });
    expect(first.matchedApplicationId).toBe(sam.applicationId);
    expect(await applicationRow(sam.applicationId)).toMatchObject({ attributedSessionId: other, attributionMethod: "scanned_session" });

    // The same mobile twice on one list is refused, so one application never has two rows.
    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "Sam again", mobile: sam.mobile, source: "staff_added" }), "mobile_on_list");
    const unmatched = await addAttendee(db, { sessionId, staff, nameAsWritten: "Sam's cousin", source: "staff_added" });
    await expectSessionError(confirmMatch(db, { attendeeId: unmatched.attendeeId, applicationId: sam.applicationId, staff }), "application_on_list");
  });

  it("never links across openings, by phone or by hand", async () => {
    const windowOpeningId = await loadWindowOpening(db);
    const windowSession = await createSessionAt(db, windowOpeningId, adminId);
    const lee = await createApplicant(db, snow, { firstName: "Lee" });

    const added = await addAttendee(db, { sessionId: windowSession, staff, nameAsWritten: `Lee ${lee.lastName}`, mobile: lee.mobile, source: "paper_sheet" });
    expect(added.matchedApplicationId).toBeNull();
    expect((await matchSessionByPhone(db, windowSession)).linked).toBe(0);
    expect(await attendeeRow(added.attendeeId)).toMatchObject({ applicationId: null, matchMethod: "none" });
    await expectSessionError(confirmMatch(db, { attendeeId: added.attendeeId, applicationId: lee.applicationId, staff }), "wrong_opening");

    // Nor is the snow application suggested on the window session's list, same name or not.
    const list = await loadSessionAttendees(db, windowSession, { suggestions: true });
    expect(list.attendees.find((a) => a.id === added.attendeeId)!.suggestions).toEqual([]);
    expect(list.choices.some((c) => c.applicationId === lee.applicationId)).toBe(false);
    expect(await applicationRow(lee.applicationId)).toMatchObject({ attributedSessionId: null });
  });

  it("matches an application made after the session when the session page loads", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const mobile = nextMobile();
    const checkedIn = await checkIn(db, { sessionId, staff, name: "Robin Later", mobile: typed(mobile) });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: null, source: "door_checkin" });

    const robin = await createApplicant(db, snow, { firstName: "Robin", mobile });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: null });

    expect(await matchSessionByPhone(db, sessionId)).toEqual({ linked: 1 });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: robin.applicationId, matchMethod: "phone_match" });
    // A door check-in on time sets the arrival nobody recorded.
    expect(await applicationRow(robin.applicationId)).toMatchObject({ attributedSessionId: sessionId, groupInterviewArrival: "on_time" });
    expect(await matchSessionByPhone(db, sessionId)).toEqual({ linked: 0 });
  });

  it("matches at once when the person applies on the landing form after checking in", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const mobile = nextMobile();
    const checkedIn = await checkIn(db, { sessionId, staff, name: "Casey Walkin", mobile });
    const [consentText] = await db.select({ id: legalTextVersion.id }).from(legalTextVersion).where(eq(legalTextVersion.kind, "sms_consent"));

    const landed = await landApplicant(db, {
      openingId: snow.openingId,
      entryChannel: "role_qr",
      firstName: "Casey",
      lastName: uniqueLastName("Walkin"),
      mobile,
      email: `casey-${mobile.slice(2)}@example.test`,
      textConsent: { checked: false, legalTextVersionId: consentText!.id },
    });
    expect(landed.outcome).toBe("created");
    if (landed.outcome !== "created") return;
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: landed.applicationId, matchMethod: "phone_match" });
    expect(await applicationRow(landed.applicationId)).toMatchObject({
      attributedSessionId: sessionId,
      attributionMethod: "phone_match",
      groupInterviewArrival: "on_time",
    });
  });

  it("does not link a number marked as shared, and offers it as a suggestion instead", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const shared = await createApplicant(db, snow, { firstName: "Alex" });
    await sql`update person set shared_mobile = true where id = ${shared.personId}`;

    const added = await addAttendee(db, { sessionId, staff, nameAsWritten: "Someone Else", mobile: shared.mobile, source: "paper_sheet" });
    expect(added.matchedApplicationId).toBeNull();
    const list = await loadSessionAttendees(db, sessionId, { suggestions: true });
    const row = list.attendees.find((a) => a.id === added.attendeeId)!;
    expect(row.suggestions.map((s) => [s.applicationId, s.kind])).toEqual([[shared.applicationId, "shared_phone"]]);
  });
});

describe("name suggestions", () => {
  it("only suggests a name match, and staff confirm or dismiss it", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const jordan = await createApplicant(db, snow, { firstName: "Jordan", lastName: uniqueLastName("Brightwater") });

    const initial = await addAttendee(db, { sessionId, staff, nameAsWritten: `J. ${jordan.lastName}`, source: "paper_sheet" });
    const fullName = await addAttendee(db, { sessionId, staff, nameAsWritten: `jordan ${jordan.lastName.toUpperCase()}`, source: "paper_sheet" });
    expect(initial.matchedApplicationId).toBeNull();
    expect(fullName.matchedApplicationId).toBeNull();
    expect((await matchSessionByPhone(db, sessionId)).linked).toBe(0);

    let list = await loadSessionAttendees(db, sessionId, { suggestions: true });
    const suggestionsFor = (id: string) => list.attendees.find((a) => a.id === id)!.suggestions.map((s) => [s.applicationId, s.kind]);
    expect(suggestionsFor(initial.attendeeId)).toEqual([[jordan.applicationId, "initial_and_last"]]);
    expect(suggestionsFor(fullName.attendeeId)).toEqual([[jordan.applicationId, "same_name"]]);
    expect(await attendeeRow(initial.attendeeId)).toMatchObject({ applicationId: null });

    // "Not them" for the initial; it is not offered again.
    await dismissSuggestion(db, { attendeeId: initial.attendeeId, applicationId: jordan.applicationId, staff });
    list = await loadSessionAttendees(db, sessionId, { suggestions: true });
    expect(suggestionsFor(initial.attendeeId)).toEqual([]);

    // "It's them" for the full name.
    expect(await confirmMatch(db, { attendeeId: fullName.attendeeId, applicationId: jordan.applicationId, staff })).toEqual({ changed: true });
    expect(await attendeeRow(fullName.attendeeId)).toMatchObject({ applicationId: jordan.applicationId, matchMethod: "staff_confirmed", matchedBy: adminId });
    expect(await applicationRow(jordan.applicationId)).toMatchObject({ attributedSessionId: sessionId, attributionMethod: "staff_confirmed" });
    expect(await confirmMatch(db, { attendeeId: fullName.attendeeId, applicationId: jordan.applicationId, staff })).toEqual({ changed: false });

    // The profile panel shows the match, and a staff member sees no suggestion left for it.
    const attendance = await loadApplicationAttendance(db, jordan.applicationId, "admin");
    expect(attendance!.rows.map((r) => r.attendeeId)).toEqual([fullName.attendeeId]);
    expect(attendance!.suggestions).toEqual([]);
  });

  it("shows a waiting name match on the applicant's profile to staff only", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const kim = await createApplicant(db, snow, { firstName: "Kim", lastName: uniqueLastName("Ostrander") });
    const added = await addAttendee(db, { sessionId, staff, nameAsWritten: `Kim ${kim.lastName}`, source: "paper_sheet" });

    const forStaff = await loadApplicationAttendance(db, kim.applicationId, "hiring_manager");
    expect(forStaff!.rows).toEqual([]);
    expect(forStaff!.suggestions.map((s) => [s.attendeeId, s.kind, s.sessionId])).toEqual([[added.attendeeId, "same_name", sessionId]]);
    const forViewer = await loadApplicationAttendance(db, kim.applicationId, "viewer");
    expect(forViewer!.suggestions).toEqual([]);
  });
});

describe("unmatching", () => {
  it("drops the link, takes back the attribution and arrival it set, and never re-links the pair on its own", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date(Date.now() - 60_000));
    const drew = await createApplicant(db, snow, { firstName: "Drew" });
    const checkedIn = await checkIn(db, { sessionId, staff, name: "Drew Shared Phone", mobile: drew.mobile });
    expect(await applicationRow(drew.applicationId)).toMatchObject({ attributedSessionId: sessionId, groupInterviewArrival: "on_time" });

    await unmatchAttendee(db, { attendeeId: checkedIn.attendeeId, staff });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: null, personId: null, matchMethod: "none", matchedAt: null });
    expect(await applicationRow(drew.applicationId)).toMatchObject({ attributedSessionId: null, attributionMethod: "none", groupInterviewArrival: null });
    const unmatch = await latestAudit(db, checkedIn.attendeeId, "attendee.unmatch");
    expect(unmatch).toMatchObject({ actorType: "staff", actorUserId: adminId, applicationId: drew.applicationId });

    // Page loads, the profile and a new check-in by the same phone leave the pair alone.
    expect((await matchSessionByPhone(db, sessionId)).linked).toBe(0);
    expect((await matchApplicationByPhone(db, drew.applicationId)).linked).toBe(0);
    await checkIn(db, { sessionId, staff, name: "Drew Shared Phone", mobile: drew.mobile });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: null });
    await expectSessionError(unmatchAttendee(db, { attendeeId: checkedIn.attendeeId, staff }), "not_matched");

    // Staff can still link it by hand.
    await confirmMatch(db, { attendeeId: checkedIn.attendeeId, applicationId: drew.applicationId, staff });
    expect(await attendeeRow(checkedIn.attendeeId)).toMatchObject({ applicationId: drew.applicationId, matchMethod: "staff_confirmed" });
  });

  it("leaves an arrival staff changed after the match", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date(Date.now() - 60_000));
    const ari = await createApplicant(db, snow, { firstName: "Ari" });
    const checkedIn = await checkIn(db, { sessionId, staff, name: "Ari", mobile: ari.mobile });
    await setGroupInterviewArrival(db, { applicationId: ari.applicationId, userId: adminId, role: "admin", arrival: "late" });

    await unmatchAttendee(db, { attendeeId: checkedIn.attendeeId, staff });
    expect(await applicationRow(ari.applicationId)).toMatchObject({ groupInterviewArrival: "late", attributedSessionId: null });
  });

  it("removing or re-numbering a row drops its match too", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const jo = await createApplicant(db, snow, { firstName: "Jo" });
    const other = await createApplicant(db, snow, { firstName: "Mo" });
    const added = await addAttendee(db, { sessionId, staff, nameAsWritten: "Jo", mobile: jo.mobile, source: "paper_sheet" });

    // A misread number: fixing it moves the phone match to the right person.
    const fixed = await updateAttendee(db, { attendeeId: added.attendeeId, staff, mobile: other.mobile });
    expect(fixed).toMatchObject({ changed: ["mobileE164"], matchedApplicationId: other.applicationId });
    expect(await applicationRow(jo.applicationId)).toMatchObject({ attributedSessionId: null });
    expect(await applicationRow(other.applicationId)).toMatchObject({ attributedSessionId: sessionId });

    await removeAttendee(db, { attendeeId: added.attendeeId, staff });
    expect(await attendeeRow(added.attendeeId)).toMatchObject({ applicationId: null });
    expect((await attendeeRow(added.attendeeId)).deletedAt).not.toBeNull();
    expect(await applicationRow(other.applicationId)).toMatchObject({ attributedSessionId: null });
    // The application can be matched to a new row on the same session.
    const again = await addAttendee(db, { sessionId, staff, nameAsWritten: "Mo", source: "paper_sheet" });
    await confirmMatch(db, { attendeeId: again.attendeeId, applicationId: other.applicationId, staff });
    expect((await loadSessionAttendees(db, sessionId)).attendees.map((a) => a.id)).toEqual([again.attendeeId]);
  });
});

describe("arrival from a door check-in", () => {
  it("is on time up to five minutes after the start and late after that", () => {
    const startsAt = new Date("2026-10-28T23:00:00Z");
    expect(arrivalForCheckIn(new Date("2026-10-28T22:40:00Z"), startsAt)).toBe("on_time");
    expect(arrivalForCheckIn(new Date("2026-10-28T23:05:00Z"), startsAt)).toBe("on_time");
    expect(arrivalForCheckIn(new Date("2026-10-28T23:05:01Z"), startsAt)).toBe("late");
  });

  it("counts real minutes across the Nov 1, 2026 clock change", async () => {
    // 1:30 AM CDT on Nov 1 is 06:30Z. An hour later the clocks read 1:30 AM again (CST).
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date("2026-11-01T06:30:00Z"));
    const early = await createApplicant(db, snow, { firstName: "Early" });
    const onTime = await createApplicant(db, snow, { firstName: "Ontime" });
    const late = await createApplicant(db, snow, { firstName: "Late" });

    await checkIn(db, { sessionId, staff, name: "Early Bird", mobile: early.mobile, now: new Date("2026-11-01T06:10:00Z") });
    await checkIn(db, { sessionId, staff, name: "On Time", mobile: onTime.mobile, now: new Date("2026-11-01T06:35:00Z") });
    // 1:32 AM CST: two minutes after the start by the wall clock, but 62 minutes later in fact.
    await checkIn(db, { sessionId, staff, name: "Late Arrival", mobile: late.mobile, now: new Date("2026-11-01T07:32:00Z") });

    expect((await applicationRow(early.applicationId)).groupInterviewArrival).toBe("on_time");
    expect((await applicationRow(onTime.applicationId)).groupInterviewArrival).toBe("on_time");
    expect((await applicationRow(late.applicationId)).groupInterviewArrival).toBe("late");

    const audit = await latestAudit(db, late.applicationId, "application.arrival_change");
    expect(audit).toMatchObject({ actorType: "system" });
    expect(audit!.changes).toMatchObject({ groupInterviewArrival: { from: null, to: "late" }, groupSessionId: sessionId, checkedInAt: "2026-11-01T07:32:00.000Z" });
  });

  it("never overwrites an arrival already recorded, and a sheet row sets none", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date(Date.now() - 3_600_000));
    const recorded = await createApplicant(db, snow);
    await setGroupInterviewArrival(db, { applicationId: recorded.applicationId, userId: adminId, role: "admin", arrival: "did_not_attend" });
    await checkIn(db, { sessionId, staff, name: "Recorded", mobile: recorded.mobile });
    expect((await applicationRow(recorded.applicationId)).groupInterviewArrival).toBe("did_not_attend");

    const sheet = await createApplicant(db, snow);
    await addAttendee(db, { sessionId, staff, nameAsWritten: "From The Sheet", mobile: sheet.mobile, source: "paper_sheet" });
    expect(await applicationRow(sheet.applicationId)).toMatchObject({ attributedSessionId: sessionId, groupInterviewArrival: null });
    const changes = await db.select().from(auditLog).where(and(eq(auditLog.entityId, sheet.applicationId), eq(auditLog.action, "application.arrival_change")));
    expect(changes).toEqual([]);
  });
});
