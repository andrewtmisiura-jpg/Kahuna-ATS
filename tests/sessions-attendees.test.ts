import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, attendee, consentEvent, groupSession, opening } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { ConfigError } from "@/server/services/config/errors";
import { getSession, listSessions, updateSession } from "@/server/services/config/sessions";
import { addAttendee, checkIn, checkInState, removeAttendee, updateAttendee } from "@/server/services/sessions/attendees";
import { SessionError, type SessionStaff } from "@/server/services/sessions/errors";
import { loadSessionAttendees } from "@/server/services/sessions/queries";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { auditActions, createApplicant, createSessionAt, createStaff, latestAudit, typed } from "./helpers/sessions";

// Who came to a group interview (services/sessions/attendees.ts): rows from the paper
// sign-up sheet and staff, the door check-in kiosk with its date rule and duplicate
// handling, and the attended count on the session screens.

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

async function expectSessionError(run: Promise<unknown>, code: SessionError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof SessionError && error.code === code);
}

async function rowsOf(sessionId: string) {
  return db.select().from(attendee).where(eq(attendee.groupSessionId, sessionId));
}

describe("the sign-up sheet", () => {
  it("adds rows with or without a mobile, refuses bad input and keeps one row per mobile", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const mobile = nextMobile();

    const first = await addAttendee(db, { sessionId, staff, nameAsWritten: "  Taylor   Reyes ", mobile: typed(mobile), source: "paper_sheet" });
    const noPhone = await addAttendee(db, { sessionId, staff, nameAsWritten: "Smudged Name", mobile: "  ", source: "staff_added" });
    const rows = await rowsOf(sessionId);
    expect(rows.find((r) => r.id === first.attendeeId)).toMatchObject({ nameAsWritten: "Taylor Reyes", mobileE164: mobile, source: "paper_sheet" });
    expect(rows.find((r) => r.id === noPhone.attendeeId)).toMatchObject({ mobileE164: null, source: "staff_added", matchMethod: "none" });

    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "   ", source: "paper_sheet" }), "name_required");
    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "x".repeat(121), source: "paper_sheet" }), "name_too_long");
    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "Bad Number", mobile: "555-1234", source: "paper_sheet" }), "invalid_mobile");
    await expectSessionError(
      addAttendee(db, { sessionId, staff, nameAsWritten: "Kiosk Only", source: "door_checkin" as "paper_sheet" }),
      "invalid_source",
    );
    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "Taylor again", mobile, source: "paper_sheet" }), "mobile_on_list");
    expect(await rowsOf(sessionId)).toHaveLength(2);
  });

  it("edits a row and removes it with a soft delete, audited without contact details", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const taken = nextMobile();
    await addAttendee(db, { sessionId, staff, nameAsWritten: "Holds A Number", mobile: taken, source: "paper_sheet" });
    const added = await addAttendee(db, { sessionId, staff, nameAsWritten: "Jamie Misread", source: "paper_sheet" });

    const mobile = nextMobile();
    const edited = await updateAttendee(db, { attendeeId: added.attendeeId, staff, nameAsWritten: "Jamie Misreed", mobile, source: "staff_added" });
    expect(edited.changed.sort()).toEqual(["mobileE164", "nameAsWritten", "source"]);
    expect(await updateAttendee(db, { attendeeId: added.attendeeId, staff, nameAsWritten: "Jamie Misreed" })).toMatchObject({ changed: [] });
    await expectSessionError(updateAttendee(db, { attendeeId: added.attendeeId, staff, mobile: taken }), "mobile_on_list");
    const update = await latestAudit(db, added.attendeeId, "attendee.update");
    expect(update!.changes).toMatchObject({
      nameAsWritten: { from: "[changed]", to: "[changed]" },
      mobileE164: { from: "[changed]", to: "[changed]" },
      source: { from: "paper_sheet", to: "staff_added" },
    });

    await removeAttendee(db, { attendeeId: added.attendeeId, staff });
    const [removed] = await db.select().from(attendee).where(eq(attendee.id, added.attendeeId));
    expect(removed!.deletedAt).not.toBeNull();
    expect(removed!.nameAsWritten).toBe("Jamie Misreed");
    expect((await loadSessionAttendees(db, sessionId)).attendees.map((a) => a.nameAsWritten)).toEqual(["Holds A Number"]);
    expect(await auditActions(db, added.attendeeId)).toEqual(["attendee.add", "attendee.update", "attendee.remove"]);
    await expectSessionError(removeAttendee(db, { attendeeId: added.attendeeId, staff }), "attendee_not_found");
    // A removed row's mobile is free for a new row.
    await addAttendee(db, { sessionId, staff, nameAsWritten: "Jamie", mobile, source: "paper_sheet" });
  });

  it("takes no new rows on a canceled session", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date(), "canceled");
    await expectSessionError(addAttendee(db, { sessionId, staff, nameAsWritten: "Too Late", source: "paper_sheet" }), "session_canceled");
  });

  it("counts attended from the list once anyone is on it, else the typed headcount", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, adminId);
      await tx.update(groupSession).set({ attendedCount: 12 }).where(eq(groupSession.id, sessionId));
      let row = (await listSessions(tx)).find((s) => s.id === sessionId)!;
      expect(row).toMatchObject({ attendedCount: 12, attendeeCount: 0, attended: 12 });

      const pat = await createApplicant(tx, snow);
      await addAttendee(tx, { sessionId, staff, nameAsWritten: "Pat", mobile: pat.mobile, source: "paper_sheet" });
      await addAttendee(tx, { sessionId, staff, nameAsWritten: "Lee", source: "paper_sheet" });
      const gone = await addAttendee(tx, { sessionId, staff, nameAsWritten: "Gone", source: "paper_sheet" });
      await removeAttendee(tx, { attendeeId: gone.attendeeId, staff });
      row = (await listSessions(tx)).find((s) => s.id === sessionId)!;
      expect(row).toMatchObject({ attendedCount: 12, attendeeCount: 2, matchedCount: 1, attended: 2 });
      expect(await getSession(tx, sessionId)).toMatchObject({ attended: 2, startedCount: 1 });
    });
  });

  it("keeps the session's opening once anyone on its list is matched to an application", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, adminId);
      const pat = await createApplicant(tx, snow);
      const added = await addAttendee(tx, { sessionId, staff, nameAsWritten: "Pat", mobile: pat.mobile, source: "paper_sheet" });
      // The application's own attribution is cleared so only the attendee holds the session.
      await tx.update(application).set({ attributedSessionId: null, attributionMethod: "none" }).where(eq(application.id, pat.applicationId));
      const [windowOpening] = await tx.select().from(opening).where(eq(opening.key, "window-2027"));
      await expect(updateSession(tx, { actor: staffActor(adminId), id: sessionId, patch: { openingId: windowOpening!.id } })).rejects.toSatisfy(
        (error: unknown) => error instanceof ConfigError && error.code === "session_has_applicants",
      );
      expect(added.matchedApplicationId).toBe(pat.applicationId);
    });
  });
});

describe("the door check-in", () => {
  it("is open all day (Central) on the day of a scheduled or held session, and closed otherwise", () => {
    // 6 PM CDT on Oct 28, 2026.
    const startsAt = new Date("2026-10-28T23:00:00Z");
    expect(checkInState({ status: "scheduled", startsAt }, new Date("2026-10-28T14:00:00Z"))).toEqual({ open: true });
    expect(checkInState({ status: "held", startsAt }, new Date("2026-10-29T04:59:00Z"))).toEqual({ open: true });
    expect(checkInState({ status: "held", startsAt }, new Date("2026-10-29T05:00:00Z"))).toEqual({ open: false, reason: "over" });
    expect(checkInState({ status: "scheduled", startsAt }, new Date("2026-10-28T04:59:00Z"))).toEqual({ open: false, reason: "not_yet" });
    expect(checkInState({ status: "canceled", startsAt }, new Date("2026-10-28T20:00:00Z"))).toEqual({ open: false, reason: "canceled" });

    // Nov 1, 2026 has 25 hours in Central: 11:30 PM CST is 05:30Z on Nov 2.
    const lateNov1 = new Date("2026-11-02T05:30:00Z");
    expect(checkInState({ status: "scheduled", startsAt: lateNov1 }, new Date("2026-11-01T05:15:00Z"))).toEqual({ open: true });
    expect(checkInState({ status: "scheduled", startsAt: lateNov1 }, new Date("2026-11-02T05:59:00Z"))).toEqual({ open: true });
    expect(checkInState({ status: "scheduled", startsAt: lateNov1 }, new Date("2026-11-01T04:59:00Z"))).toEqual({ open: false, reason: "not_yet" });
    expect(checkInState({ status: "scheduled", startsAt: lateNov1 }, new Date("2026-11-02T06:00:00Z"))).toEqual({ open: false, reason: "over" });
  });

  it("refuses a check-in on any other day or on a canceled session", async () => {
    const tomorrow = await createSessionAt(db, snow.openingId, adminId, new Date(Date.now() + 86_400_000 * 2), "scheduled");
    const yesterday = await createSessionAt(db, snow.openingId, adminId, new Date(Date.now() - 86_400_000 * 2), "held");
    const canceled = await createSessionAt(db, snow.openingId, adminId, new Date(), "canceled");
    for (const sessionId of [tomorrow, yesterday, canceled]) {
      await expectSessionError(checkIn(db, { sessionId, staff, name: "Pat Door", mobile: nextMobile() }), "checkin_closed");
      expect(await rowsOf(sessionId)).toEqual([]);
    }
  });

  it("updates the existing row when the same phone checks in twice, keeping the first time", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId, new Date("2026-11-01T23:00:00Z"));
    const mobile = nextMobile();
    const first = await checkIn(db, { sessionId, staff, name: "Chris P", mobile: typed(mobile), now: new Date("2026-11-01T22:50:00Z") });
    const again = await checkIn(db, { sessionId, staff, name: "Chris Parker", mobile: mobile.slice(2), now: new Date("2026-11-01T23:20:00Z") });
    expect(first).toMatchObject({ firstName: "Chris", repeat: false });
    expect(again).toMatchObject({ attendeeId: first.attendeeId, repeat: true });

    const rows = await rowsOf(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nameAsWritten: "Chris Parker", mobileE164: mobile, source: "door_checkin" });
    expect(rows[0]!.createdAt.toISOString()).toBe("2026-11-01T22:50:00.000Z");
  });

  it("records no text consent and needs a name and a valid mobile", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const sam = await createApplicant(db, snow);
    await checkIn(db, { sessionId, staff, name: "Sam", mobile: sam.mobile });
    const consents = await db.select().from(consentEvent).where(eq(consentEvent.personId, sam.personId));
    expect(consents).toEqual([]);
    const byAddress = await db.select().from(consentEvent).where(eq(consentEvent.address, sam.mobile));
    expect(byAddress).toEqual([]);

    await expectSessionError(checkIn(db, { sessionId, staff, name: " ", mobile: nextMobile() }), "name_required");
    await expectSessionError(checkIn(db, { sessionId, staff, name: "No Phone", mobile: "" }), "invalid_mobile");
    await expectSessionError(checkIn(db, { sessionId, staff, name: "Short Phone", mobile: "612555" }), "invalid_mobile");
  });
});

describe("who may act", () => {
  it("refuses a Viewer every write and the kiosk", async () => {
    await withRollback(db, async (tx) => {
      const viewer = await createStaff(tx, "viewer");
      const sessionId = await createSessionAt(tx, snow.openingId, adminId);
      const added = await addAttendee(tx, { sessionId, staff, nameAsWritten: "Pat", source: "paper_sheet" });
      await expectSessionError(addAttendee(tx, { sessionId, staff: viewer, nameAsWritten: "Pat", source: "paper_sheet" }), "not_allowed");
      await expectSessionError(updateAttendee(tx, { attendeeId: added.attendeeId, staff: viewer, nameAsWritten: "Patrick" }), "not_allowed");
      await expectSessionError(removeAttendee(tx, { attendeeId: added.attendeeId, staff: viewer }), "not_allowed");
      await expectSessionError(checkIn(tx, { sessionId, staff: viewer, name: "Pat", mobile: nextMobile() }), "not_allowed");

      // A Hiring Manager acts like an Admin here.
      const manager = await createStaff(tx, "hiring_manager");
      await addAttendee(tx, { sessionId, staff: manager, nameAsWritten: "Morgan", source: "staff_added" });
      await checkIn(tx, { sessionId, staff: manager, name: "Morgan Door", mobile: nextMobile() });
    });
  });
});
