import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, auditLog, groupSession, opening, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { DetailError, setAttributedSession, updateSource } from "@/server/services/applications/details";
import { listApplications, loadProfile } from "@/server/services/applications/queries";
import { createApplication, transition } from "@/server/services/applications/transition";
import { createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// Staff edits on the profile's Details: how they heard about us and the
// attributed group session. Both are audited, and the session drives the list's
// session filter.

const TAG = "Qzdetails";

let snow: SnowFixture;
let adminId: string;
let sessionId: string;
let otherSessionId: string;
let canceledId: string;
let windowSessionId: string;
const applicant = { type: "applicant" } as const;

async function newSession(openingId: string, extra: Partial<typeof groupSession.$inferInsert> = {}) {
  const id = uuidv7();
  await db.insert(groupSession).values({
    id,
    openingId,
    startsAt: new Date("2026-10-22T23:00:00Z"),
    locationName: `Golden Valley shop ${TAG}`,
    status: "scheduled",
    createdBy: adminId,
    ...extra,
  });
  return id;
}

async function newApplication(options: { scannedSessionId?: string; source?: "indeed" | "current_employee" } = {}) {
  const personId = await createPerson(db, { lastName: `Person${TAG}` });
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: options.scannedSessionId ? "session_qr" : "role_qr",
    scannedSessionId: options.scannedSessionId ?? null,
    source: options.source ?? null,
    actor: applicant,
  });
  await transition(db, { action: "submit", applicationId, actor: applicant });
  return applicationId;
}

async function load(applicationId: string) {
  const [row] = await db.select().from(application).where(eq(application.id, applicationId));
  return row!;
}

async function lastAudit(applicationId: string, action: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.applicationId, applicationId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
  sessionId = await newSession(snow.openingId);
  otherSessionId = await newSession(snow.openingId, { locationName: `Plymouth office ${TAG}`, startsAt: new Date("2026-10-29T23:00:00Z") });
  canceledId = await newSession(snow.openingId, { status: "canceled" });
  // The seeded window opening (a draft) stands in for "another opening".
  const [windowOpening] = await db
    .select({ id: opening.id })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .where(eq(role.key, "window_cleaning_tech"));
  windowSessionId = await newSession(windowOpening!.id);
});

afterAll(async () => {
  await sql.end();
});

describe("source", () => {
  it("sets the source and detail with the applicant's list, audited with the detail hidden", async () => {
    const applicationId = await newApplication();
    const result = await updateSource(db, { applicationId, userId: adminId, source: "referral", sourceDetail: "  Jamie at the shop " });
    expect(result.changed.sort()).toEqual(["source", "sourceDetail"]);
    const row = await load(applicationId);
    expect(row).toMatchObject({ source: "referral", sourceDetail: "Jamie at the shop", sourceSetBy: "staff", excludeFromAnalysis: false });
    const audit = await lastAudit(applicationId, "application.source_change");
    expect(audit).toMatchObject({ actorType: "staff", actorUserId: adminId, entityType: "application", entityId: applicationId });
    expect(audit!.changes).toEqual({ source: { from: null, to: "referral" }, sourceDetail: { from: "[changed]", to: "[changed]" } });

    // A source without a detail drops it; the same values again change nothing.
    await updateSource(db, { applicationId, userId: adminId, source: "indeed", sourceDetail: "ignored" });
    expect(await load(applicationId)).toMatchObject({ source: "indeed", sourceDetail: null });
    expect(await updateSource(db, { applicationId, userId: adminId, source: "indeed" })).toEqual({ changed: [] });

    // Clearing it.
    await updateSource(db, { applicationId, userId: adminId, source: null });
    expect(await load(applicationId)).toMatchObject({ source: null, sourceSetBy: null });

    const profile = await loadProfile(db, applicationId, "admin");
    expect(profile!.application.source).toBeNull();
  });

  it("a current employee is left out of analysis, and back in when the source changes", async () => {
    const applicationId = await newApplication({ source: "indeed" });
    await updateSource(db, { applicationId, userId: adminId, source: "current_employee" });
    expect((await load(applicationId)).excludeFromAnalysis).toBe(true);
    expect((await lastAudit(applicationId, "application.source_change"))!.changes).toMatchObject({ excludeFromAnalysis: { from: false, to: true } });
    await updateSource(db, { applicationId, userId: adminId, source: "former_employee" });
    expect((await load(applicationId)).excludeFromAnalysis).toBe(false);
  });

  it("refuses a source outside the list and an unknown application", async () => {
    const applicationId = await newApplication();
    await expect(updateSource(db, { applicationId, userId: adminId, source: "billboard" as "indeed" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(updateSource(db, { applicationId: uuidv7(), userId: adminId, source: "indeed" })).rejects.toBeInstanceOf(DetailError);
  });
});

describe("group session", () => {
  it("staff set the session for a role QR scan, audited, and the list filter finds it", async () => {
    const applicationId = await newApplication();
    expect((await loadProfile(db, applicationId, "admin"))!.application.session).toBeNull();

    expect(await setAttributedSession(db, { applicationId, userId: adminId, sessionId })).toEqual({ changed: true });
    expect(await load(applicationId)).toMatchObject({ attributedSessionId: sessionId, attributionMethod: "staff_confirmed", scannedSessionId: null });
    const audit = await lastAudit(applicationId, "application.session_attribution");
    expect(audit!.changes).toEqual({
      attributedSessionId: { from: null, to: sessionId },
      attributionMethod: { from: "none", to: "staff_confirmed" },
    });

    const profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.application.session).toMatchObject({ id: sessionId, locationName: `Golden Valley shop ${TAG}` });
    expect(profile.application.attributionMethod).toBe("staff_confirmed");
    expect(profile.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([sessionId, otherSessionId, canceledId]));
    expect((await loadProfile(db, applicationId, "viewer"))!.sessions).toEqual([]);

    const page = await listApplications(db, { openingId: snow.openingId, sessionId, search: TAG }, "admin");
    expect(page.rows.map((r) => r.id)).toEqual([applicationId]);
    expect(page.rows[0]!.sessionLabel).toContain("Golden Valley shop");

    // Moving to another session and clearing it.
    await setAttributedSession(db, { applicationId, userId: adminId, sessionId: otherSessionId });
    expect((await listApplications(db, { openingId: snow.openingId, sessionId, search: TAG }, "admin")).rows).toEqual([]);
    expect(await setAttributedSession(db, { applicationId, userId: adminId, sessionId: null })).toEqual({ changed: true });
    expect(await load(applicationId)).toMatchObject({ attributedSessionId: null, attributionMethod: "none" });
    expect(await setAttributedSession(db, { applicationId, userId: adminId, sessionId: null })).toEqual({ changed: false });
    const none = await listApplications(db, { openingId: snow.openingId, sessionId: "none", search: TAG }, "admin");
    expect(none.rows.map((r) => r.id)).toContain(applicationId);
  });

  it("picking the scanned session again restores that attribution", async () => {
    const applicationId = await newApplication({ scannedSessionId: sessionId });
    expect(await load(applicationId)).toMatchObject({ attributedSessionId: sessionId, attributionMethod: "scanned_session" });
    await setAttributedSession(db, { applicationId, userId: adminId, sessionId: null });
    await setAttributedSession(db, { applicationId, userId: adminId, sessionId });
    expect(await load(applicationId)).toMatchObject({ attributedSessionId: sessionId, attributionMethod: "scanned_session" });
  });

  it("saving the session already attributed keeps its method, and a deleted session drops off the profile", async () => {
    const applicationId = await newApplication();
    // Matched by phone, as the Phase 2 sign-in sheet will do.
    await db.update(application).set({ attributedSessionId: otherSessionId, attributionMethod: "phone_match" }).where(eq(application.id, applicationId));
    expect(await setAttributedSession(db, { applicationId, userId: adminId, sessionId: otherSessionId })).toEqual({ changed: false });
    expect((await load(applicationId)).attributionMethod).toBe("phone_match");
    expect(await lastAudit(applicationId, "application.session_attribution")).toBeNull();

    const gone = await newSession(snow.openingId, { locationName: `Gone ${TAG}` });
    await setAttributedSession(db, { applicationId, userId: adminId, sessionId: gone });
    await db.update(groupSession).set({ deletedAt: new Date() }).where(eq(groupSession.id, gone));
    const profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.application.session).toBeNull();
    expect(profile.sessions.map((s) => s.id)).not.toContain(gone);
    // Clearing it still works.
    expect(await setAttributedSession(db, { applicationId, userId: adminId, sessionId: null })).toEqual({ changed: true });
  });

  it("refuses a session of another opening, a canceled one and a deleted one", async () => {
    const applicationId = await newApplication();
    await expect(setAttributedSession(db, { applicationId, userId: adminId, sessionId: windowSessionId })).rejects.toMatchObject({
      code: "session_wrong_opening",
    });
    await expect(setAttributedSession(db, { applicationId, userId: adminId, sessionId: canceledId })).rejects.toMatchObject({ code: "session_canceled" });
    const deleted = await newSession(snow.openingId, { deletedAt: new Date() });
    await expect(setAttributedSession(db, { applicationId, userId: adminId, sessionId: deleted })).rejects.toMatchObject({ code: "session_not_found" });
    await expect(setAttributedSession(db, { applicationId, userId: adminId, sessionId: uuidv7() })).rejects.toMatchObject({ code: "session_not_found" });
    expect((await load(applicationId)).attributedSessionId).toBeNull();
  });
});
