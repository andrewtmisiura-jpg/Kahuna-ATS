import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@/db";
import { attendee, star } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import {
  addAttendeeAction,
  addMarkAction,
  confirmMatchAction,
  dismissSuggestionAction,
  matchNowAction,
  removeAttendeeAction,
  removeMarkAction,
  unmatchAttendeeAction,
  updateAttendeeAction,
} from "@/server/actions/admin/attendees";
import { checkInAction } from "@/server/actions/kiosk/check-in";
import type { UserRole } from "@/server/auth/roles";
import { addAttendee } from "@/server/services/sessions/attendees";
import { loggableError } from "@/server/services/sessions/errors";
import { loadAdminId, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { createApplicant, createSessionAt } from "./helpers/sessions";

// The group session actions and the door check-in action go through requireRole (the
// kiosk through kioskAccess, which calls it) before anything else: Admins and Hiring
// Managers act, a Viewer or a signed-out request changes nothing. requireRole is
// replaced here by a stand-in that answers as the role under test would.

const auth = vi.hoisted(() => ({ role: null as UserRole | null, userId: "" }));

vi.mock("@/server/auth/require-role", async () => {
  const { AccessDeniedError, NotSignedInError } = await import("@/server/auth/authorize");
  return {
    AccessDeniedError,
    NotSignedInError,
    requireRole: async (allowed: UserRole | readonly UserRole[]) => {
      if (!auth.role) throw new NotSignedInError();
      const roles = typeof allowed === "string" ? [allowed] : allowed;
      if (!roles.includes(auth.role)) throw new AccessDeniedError();
      return { id: auth.userId, email: TEST_ADMIN_EMAIL, name: null, role: auth.role, isDevBypass: false };
    },
  };
});

let snow: SnowFixture;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
});

beforeEach(() => {
  auth.userId = adminId;
});

afterAll(async () => {
  await sql.end();
});

describe("who may use the session actions", () => {
  it("refuses a Viewer every write and changes nothing", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const sam = await createApplicant(db, snow);
    const { attendeeId } = await addAttendee(db, { sessionId, staff: { userId: adminId, role: "admin" }, nameAsWritten: "Pat", source: "paper_sheet" });
    auth.role = "viewer";

    const results = await Promise.all([
      addAttendeeAction({ sessionId, nameAsWritten: "Viewer Added", mobile: null, source: "paper_sheet" }),
      updateAttendeeAction({ attendeeId, nameAsWritten: "Renamed" }),
      removeAttendeeAction({ attendeeId }),
      matchNowAction({ sessionId }),
      confirmMatchAction({ attendeeId, applicationId: sam.applicationId }),
      dismissSuggestionAction({ attendeeId, applicationId: sam.applicationId }),
      unmatchAttendeeAction({ attendeeId }),
      addMarkAction({ attendeeId, mark: "star" }),
      removeMarkAction({ attendeeId, mark: "star" }),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, status: 403, code: "access_denied" });

    const kiosk = await checkInAction({ sessionId, name: "Viewer Kiosk", mobile: nextMobile() });
    expect(kiosk).toMatchObject({ ok: false, field: null });

    const rows = await db.select().from(attendee).where(eq(attendee.groupSessionId, sessionId));
    expect(rows.map((r) => [r.nameAsWritten, r.applicationId, r.deletedAt])).toEqual([["Pat", null, null]]);
    expect(await db.select().from(star).where(eq(star.attendeeId, attendeeId))).toEqual([]);
  });

  it("sends a signed-out request to sign-in", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    auth.role = null;
    expect(await addAttendeeAction({ sessionId, nameAsWritten: "Nobody", source: "paper_sheet" })).toMatchObject({ ok: false, status: 401 });
    await expect(checkInAction({ sessionId, name: "Nobody", mobile: nextMobile() })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await db.select().from(attendee).where(eq(attendee.groupSessionId, sessionId))).toEqual([]);
  });

  it("lets Admins and Hiring Managers act, with plain errors", async () => {
    const sessionId = await createSessionAt(db, snow.openingId, adminId);
    const sam = await createApplicant(db, snow);
    for (const role of ["admin", "hiring_manager"] as const) {
      auth.role = role;
      const added = await addAttendeeAction({ sessionId, nameAsWritten: `Added by ${role}`, mobile: null, source: "staff_added" });
      expect(added).toMatchObject({ ok: true, data: { matched: false } });
    }
    auth.role = "hiring_manager";
    const matched = await addAttendeeAction({ sessionId, nameAsWritten: "Sam", mobile: sam.mobile, source: "paper_sheet" });
    expect(matched).toMatchObject({ ok: true, data: { matched: true } });
    if (!matched.ok) return;

    const twice = await addAttendeeAction({ sessionId, nameAsWritten: "Sam again", mobile: sam.mobile, source: "paper_sheet" });
    expect(twice).toMatchObject({ ok: false, status: 400, code: "mobile_on_list" });
    expect(await addMarkAction({ attendeeId: matched.data.attendeeId, mark: "concern" })).toMatchObject({ ok: false, status: 400, code: "reason_required" });
    expect(await addMarkAction({ attendeeId: matched.data.attendeeId, mark: "star", note: "Good questions" })).toEqual({ ok: true, data: { added: true } });
    expect(await removeMarkAction({ attendeeId: matched.data.attendeeId, mark: "star" })).toEqual({ ok: true, data: { removed: true } });
    expect(await unmatchAttendeeAction({ attendeeId: "not-a-uuid" })).toMatchObject({ ok: false, status: 400, code: "invalid_input" });
    expect(await removeAttendeeAction({ attendeeId: "018f0000-0000-7000-8000-000000000000" })).toMatchObject({ ok: false, status: 404 });

    const kiosk = await checkInAction({ sessionId, name: "Door Person", mobile: "612555" });
    expect(kiosk).toEqual({ ok: false, field: "mobile", message: "Enter a 10-digit US mobile number" });
    expect(await checkInAction({ sessionId, name: "Door Person", mobile: nextMobile() })).toEqual({ ok: true, firstName: "Door" });
  });

  it("logs a failed query without the name or mobile it carried", () => {
    const failed = new DrizzleQueryError("insert into attendee values ($1, $2)", ["Pat Door", "+16125550123"], Object.assign(new Error("dup"), { code: "23505" }));
    expect(failed.message).toContain("+16125550123");
    expect(loggableError(failed)).toBe("query failed (23505)");
    expect(loggableError(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
  });
});
