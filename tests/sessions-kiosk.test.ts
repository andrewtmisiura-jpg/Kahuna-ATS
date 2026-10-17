import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { appUser } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import type { SessionStaff } from "@/server/services/sessions/errors";
import { kioskPath, kioskStaff, mintKioskToken, readKioskToken, startKiosk } from "@/server/services/sessions/kiosk";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { createSessionAt, createStaff, latestAudit } from "./helpers/sessions";

// The door check-in's own credential (sessions/kiosk.ts): a signed token for one
// session's check-in, good until midnight Central after the session's day, that the
// kiosk page and the check-in action accept in place of a staff session. Every case
// that writes runs in a rolled-back transaction.

const SECRET = "test-only-kiosk-secret-0000000000";

let snow: SnowFixture;
let admin: SessionStaff;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  admin = { userId: await loadAdminId(db), role: "admin" };
});

afterAll(async () => {
  await sql.end();
});

describe("the kiosk token", () => {
  const grant = { sessionId: uuidv7(), userId: uuidv7(), expiresAt: new Date("2026-11-03T06:00:00Z") };
  const before = new Date("2026-11-02T23:00:00Z");

  it("carries one session's grant until it expires", () => {
    const token = mintKioskToken(grant, SECRET);
    expect(readKioskToken(token, SECRET, before)).toEqual(grant);
    expect(readKioskToken(token, SECRET, grant.expiresAt)).toBeNull();
    expect(kioskPath(grant.sessionId)).toBe(`/check-in/${grant.sessionId}`);
  });

  it("accepts nothing it did not sign: another key, a changed session or a mangled token", () => {
    const token = mintKioskToken(grant, SECRET);
    expect(readKioskToken(token, "another secret", before)).toBeNull();
    const signature = token.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ s: uuidv7(), u: grant.userId, e: grant.expiresAt.getTime() })).toString("base64url");
    expect(readKioskToken(`${forged}.${signature}`, SECRET, before)).toBeNull();
    for (const mangled of ["", "nothing", `${token}.more`, `${token}x`]) expect(readKioskToken(mangled, SECRET, before)).toBeNull();
  });
});

describe("starting the kiosk", () => {
  // 6pm CST on Mon Nov 2, 2026, and that afternoon.
  const startsAt = new Date("2026-11-03T00:00:00Z");
  const afternoon = new Date("2026-11-02T22:00:00Z");

  it("grants the session's check-in until midnight Central after its day, audited", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, admin.userId, startsAt, "scheduled");
      const grant = await startKiosk(tx, { sessionId, staff: admin, now: afternoon });
      expect(grant).toEqual({ sessionId, userId: admin.userId, expiresAt: new Date("2026-11-03T06:00:00Z") });
      expect((await latestAudit(tx, sessionId, "group_session.kiosk_start"))!.changes).toEqual({ expires_at: "2026-11-03T06:00:00.000Z" });
    });
  });

  it("refuses any other day, a canceled session and a Viewer", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = await createSessionAt(tx, snow.openingId, admin.userId, startsAt, "scheduled");
      await expect(startKiosk(tx, { sessionId, staff: admin, now: new Date("2026-11-01T18:00:00Z") })).rejects.toMatchObject({ code: "checkin_closed" });
      await expect(startKiosk(tx, { sessionId, staff: admin, now: new Date("2026-11-03T18:00:00Z") })).rejects.toMatchObject({ code: "checkin_closed" });
      await expect(startKiosk(tx, { sessionId, staff: { ...admin, role: "viewer" }, now: afternoon })).rejects.toMatchObject({ code: "not_allowed" });
      const canceled = await createSessionAt(tx, snow.openingId, admin.userId, startsAt, "canceled");
      await expect(startKiosk(tx, { sessionId: canceled, staff: admin, now: afternoon })).rejects.toMatchObject({ code: "checkin_closed" });
      await expect(startKiosk(tx, { sessionId: uuidv7(), staff: admin, now: afternoon })).rejects.toMatchObject({ code: "session_not_found" });
    });
  });
});

describe("the kiosk check", () => {
  it("lets a token in for its own session only, while the staff member who started it is active", async () => {
    await withRollback(db, async (tx) => {
      const manager = await createStaff(tx, "hiring_manager");
      const sessionId = await createSessionAt(tx, snow.openingId, admin.userId);
      const now = new Date();
      const token = mintKioskToken({ sessionId, userId: manager.userId, expiresAt: new Date(now.getTime() + 3_600_000) }, SECRET);
      expect(await kioskStaff(tx, { token, sessionId, secret: SECRET, now })).toEqual(manager);
      // A staff session alone, another session's page, or no key on the server: no kiosk.
      expect(await kioskStaff(tx, { token: undefined, sessionId, secret: SECRET, now })).toBeNull();
      expect(await kioskStaff(tx, { token, sessionId: uuidv7(), secret: SECRET, now })).toBeNull();
      expect(await kioskStaff(tx, { token, sessionId, secret: undefined, now })).toBeNull();
      // Disabling the staff member stops their kiosk at once.
      await tx.update(appUser).set({ status: "disabled" }).where(eq(appUser.id, manager.userId));
      expect(await kioskStaff(tx, { token, sessionId, secret: SECRET, now })).toBeNull();
    });
  });
});
