import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { picklistOption, star } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { addAttendee, removeAttendee } from "@/server/services/sessions/attendees";
import { SessionError, type SessionStaff } from "@/server/services/sessions/errors";
import { loadApplicationAttendance, loadSessionAttendees } from "@/server/services/sessions/queries";
import { addMark, listStarReasons, removeMark, STAR_NOTE_MAX } from "@/server/services/sessions/stars";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadOption, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { auditActions, createApplicant, createSessionAt, createStaff, latestAudit } from "./helpers/sessions";

// Stars and concerns from the floor view (services/sessions/stars.ts): one live star
// and one live concern per staff member per attendee, taking one back is a soft delete,
// a concern needs a reason or a note, and notes stay within 140 characters.

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

async function newAttendee(name = "Pat Floor") {
  const sessionId = await createSessionAt(db, snow.openingId, adminId);
  const { attendeeId } = await addAttendee(db, { sessionId, staff, nameAsWritten: name, source: "paper_sheet" });
  return { sessionId, attendeeId };
}

async function starsOf(attendeeId: string) {
  return db.select().from(star).where(eq(star.attendeeId, attendeeId)).orderBy(star.createdAt);
}

describe("stars", () => {
  it("offers the seeded star reasons for the session's role", async () => {
    const { sessionId } = await newAttendee();
    const reasons = await listStarReasons(db, sessionId);
    expect(reasons.map((r) => r.key)).toEqual(["on_time", "engaged", "relevant_experience", "followed_up", "other"]);
  });

  it("gives one star per staff member, a second tap changes nothing and taking it back is a soft delete", async () => {
    const { attendeeId } = await newAttendee();
    const engaged = await loadOption(db, "star_reason", "engaged");

    const first = await addMark(db, { attendeeId, staff, mark: "star", reasonOptionId: engaged, note: "  Asked about the routes  " });
    expect(first.added).toBe(true);
    expect(await addMark(db, { attendeeId, staff, mark: "star" })).toEqual({ starId: first.starId, added: false });
    let rows = await starsOf(attendeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: adminId, mark: "star", reasonOptionId: engaged, note: "Asked about the routes", deletedAt: null });

    expect(await removeMark(db, { attendeeId, staff, mark: "star" })).toEqual({ removed: true });
    expect(await removeMark(db, { attendeeId, staff, mark: "star" })).toEqual({ removed: false });
    rows = await starsOf(attendeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).not.toBeNull();

    // Starring again after taking it back is a new row; the old one stays as it was.
    const again = await addMark(db, { attendeeId, staff, mark: "star" });
    expect(again.added).toBe(true);
    rows = await starsOf(attendeeId);
    expect(rows.map((r) => r.deletedAt === null)).toEqual([false, true]);
    expect(await auditActions(db, first.starId)).toEqual(["star.add", "star.remove"]);
    const add = await latestAudit(db, first.starId, "star.add");
    expect(add!.changes).toMatchObject({ mark: { from: null, to: "star" }, note: { from: null, to: "[changed]" }, attendeeId });
    expect(JSON.stringify(add!.changes)).not.toContain("routes");
  });

  it("lets a star and a concern from one person, and stars from several, stand together", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, adminId);
      const { attendeeId } = await addAttendee(tx, { sessionId, staff, nameAsWritten: "Busy Person", source: "paper_sheet" });
      const manager = await createStaff(tx, "hiring_manager");
      await addMark(tx, { attendeeId, staff, mark: "star" });
      await addMark(tx, { attendeeId, staff, mark: "concern", note: "Was on the phone during the talk" });
      await addMark(tx, { attendeeId, staff: manager, mark: "star" });

      const list = await loadSessionAttendees(tx, sessionId);
      const marks = list.attendees[0]!.marks;
      expect(marks.map((m) => [m.mark, m.userId])).toEqual([
        ["star", adminId],
        ["concern", adminId],
        ["star", manager.userId],
      ]);
      expect(marks.find((m) => m.userId === manager.userId)!.userName).toBe("Second Staffer");
      await removeMark(tx, { attendeeId, staff: manager, mark: "star" });
      expect((await loadSessionAttendees(tx, sessionId)).attendees[0]!.marks).toHaveLength(2);
    });
  });

  it("needs a reason or a note for a concern, and a note of at most 140 characters", async () => {
    const { attendeeId } = await newAttendee();
    const onTime = await loadOption(db, "star_reason", "on_time");
    await expectSessionError(addMark(db, { attendeeId, staff, mark: "concern" }), "reason_required");
    await expectSessionError(addMark(db, { attendeeId, staff, mark: "concern", note: "   " }), "reason_required");
    await expectSessionError(addMark(db, { attendeeId, staff, mark: "star", note: "x".repeat(STAR_NOTE_MAX + 1) }), "note_too_long");
    // A reason from another list, or not a reason at all, is refused.
    const disqualify = await loadOption(db, "disqualify_reason", "other");
    await expectSessionError(addMark(db, { attendeeId, staff, mark: "star", reasonOptionId: disqualify }), "invalid_reason");

    expect((await addMark(db, { attendeeId, staff, mark: "concern", reasonOptionId: onTime })).added).toBe(true);
    await removeMark(db, { attendeeId, staff, mark: "concern" });
    expect((await addMark(db, { attendeeId, staff, mark: "concern", note: "x".repeat(STAR_NOTE_MAX) })).added).toBe(true);
    expect((await addMark(db, { attendeeId, staff, mark: "star" })).added).toBe(true);
  });

  it("asks for a note when the picked reason needs one", async () => {
    // Inside a rolled-back transaction: the seed test fingerprints every picklist option.
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, adminId);
      const { attendeeId } = await addAttendee(tx, { sessionId, staff, nameAsWritten: "Pat", source: "paper_sheet" });
      const other = await loadOption(tx, "star_reason", "other");
      await tx.update(picklistOption).set({ requiresNote: true }).where(eq(picklistOption.id, other));
      await expectSessionError(addMark(tx, { attendeeId, staff, mark: "star", reasonOptionId: other }), "note_required");
      expect((await addMark(tx, { attendeeId, staff, mark: "star", reasonOptionId: other, note: "Fixed a ladder for us" })).added).toBe(true);
    });
  });

  it("refuses marks for a removed attendee and for a Viewer", async () => {
    const { attendeeId } = await newAttendee();
    await withRollback(db, async (tx) => {
      const viewer = await createStaff(tx, "viewer");
      await expectSessionError(addMark(tx, { attendeeId, staff: viewer, mark: "star" }), "not_allowed");
      await expectSessionError(removeMark(tx, { attendeeId, staff: viewer, mark: "star" }), "not_allowed");
    });
    await removeAttendee(db, { attendeeId, staff });
    await expectSessionError(addMark(db, { attendeeId, staff, mark: "star" }), "attendee_not_found");
    expect(await starsOf(attendeeId)).toEqual([]);
  });

  it("shows on the profile of the matched applicant, with the reason, the note and who gave it", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const pat = await createApplicant(db, snow, { firstName: "Pat" });
    const { attendeeId } = await addAttendee(db, { sessionId, staff, nameAsWritten: "Pat", mobile: pat.mobile, source: "paper_sheet" });
    const engaged = await loadOption(db, "star_reason", "engaged");
    await addMark(db, { attendeeId, staff, mark: "star", reasonOptionId: engaged, note: "Great questions" });

    for (const role of ["admin", "viewer"] as const) {
      const attendance = await loadApplicationAttendance(db, pat.applicationId, role);
      expect(attendance!.rows).toHaveLength(1);
      expect(attendance!.rows[0]!.marks).toEqual([
        expect.objectContaining({ mark: "star", reasonLabel: "Engaged or asked good questions", note: "Great questions", userId: adminId }),
      ]);
      // Viewers see no contact details.
      expect(attendance!.rows[0]!.mobile).toBe(role === "viewer" ? null : pat.mobile);
    }
  });
});
