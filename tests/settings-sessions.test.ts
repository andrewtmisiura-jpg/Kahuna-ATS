import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, auditLog, entryCode, groupSession, opening } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { closeEntryCode, createEntryCode, getEntryCode, listEntryCodes, reopenEntryCode } from "@/server/services/config/entry-codes-admin";
import { ConfigError } from "@/server/services/config/errors";
import { createSession, getSession, listSessions, sessionCodeLabel, updateSession } from "@/server/services/config/sessions";
import { recordScan, resolveEntryCode } from "@/server/services/entry-codes";
import { withRollback } from "./helpers/db";
import { createApplication, createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

async function expectConfigError(run: Promise<unknown>, code: ConfigError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof ConfigError && error.code === code);
}

// 5pm Central on Oct 28, 2026 (CDT).
const STARTS_AT = new Date("2026-10-28T22:00:00Z");

describe("group sessions", () => {
  it("creating a session creates its entry code, ready to scan", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const created = await createSession(tx, {
        actor,
        openingId: snow.openingId,
        startsAt: STARTS_AT,
        locationName: "Golden Valley shop",
        locationAddress: "123 Example Ave",
        invitedCount: 25,
      });
      expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6,8}$/);

      const [session] = await tx.select().from(groupSession).where(eq(groupSession.id, created.id));
      expect(session).toMatchObject({ status: "scheduled", invitedCount: 25, attendedCount: null, createdBy: adminId });

      const [code] = await tx.select().from(entryCode).where(eq(entryCode.id, created.entryCodeId));
      expect(code).toMatchObject({
        code: created.code,
        channel: "session_qr",
        roleId: snow.roleId,
        openingId: snow.openingId,
        groupSessionId: created.id,
        closedAt: null,
        createdBy: adminId,
      });
      expect(code!.label).toBe(sessionCodeLabel(STARTS_AT, "Golden Valley shop"));
      expect(code!.label).toBe("Session Oct 28, 2026 at Golden Valley shop");

      // The public resolver attributes a scan of that code to the session.
      const resolved = await resolveEntryCode(tx, created.code);
      expect(resolved.status).toBe("open");
      if (resolved.status === "open") {
        expect(resolved.session?.id).toBe(created.id);
        expect(resolved.opening.id).toBe(snow.openingId);
      }

      const actions = await tx
        .select({ action: auditLog.action, entityType: auditLog.entityType })
        .from(auditLog)
        .where(eq(auditLog.actorUserId, adminId));
      expect(actions).toEqual(
        expect.arrayContaining([
          { action: "group_session.create", entityType: "group_session" },
          { action: "entry_code.create", entityType: "entry_code" },
        ]),
      );

      const listed = await listSessions(tx);
      const row = listed.find((s) => s.id === created.id);
      expect(row?.code?.code).toBe(created.code);
      expect(row?.openingName).toBe("Snow Removal 2026-27");
    });
  });

  it("refuses a session on a closed opening and bad fields", async () => {
    const actor = staffActor(adminId);
    await expectConfigError(
      createSession(db, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "   " }),
      "invalid_input",
    );
    await expectConfigError(
      createSession(db, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "Shop", invitedCount: -1 }),
      "invalid_input",
    );
    await expectConfigError(createSession(db, { actor, openingId: uuidv7(), startsAt: STARTS_AT, locationName: "Shop" }), "not_found");
    await withRollback(db, async (tx) => {
      await tx.update(opening).set({ status: "closed" }).where(eq(opening.id, snow.openingId));
      await expectConfigError(createSession(tx, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "Shop" }), "opening_closed");
    });
  });

  it("shows scan counts and the applicants attributed to it", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const created = await createSession(tx, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "Shop" });
      await recordScan(tx, created.entryCodeId);
      await recordScan(tx, created.entryCodeId);
      await recordScan(tx, created.entryCodeId, new Date("2026-10-01T15:00:00Z"));

      const personId = await createPerson(tx, { firstName: "Sam", lastName: "Scanner" });
      const { applicationId } = await createApplication(tx, snow, personId);
      await tx
        .update(application)
        .set({ scannedSessionId: created.id, attributedSessionId: created.id, attributionMethod: "scanned_session" })
        .where(eq(application.id, applicationId));
      const other = await createPerson(tx);
      const second = await createApplication(tx, snow, other);
      await tx
        .update(application)
        .set({ attributedSessionId: created.id, attributionMethod: "staff_confirmed", submittedAt: new Date() })
        .where(eq(application.id, second.applicationId));

      const detail = await getSession(tx, created.id);
      expect(detail).not.toBeNull();
      expect(detail!.scansToday).toBe(2);
      expect(detail!.scansTotal).toBe(3);
      expect(detail!.startedCount).toBe(2);
      expect(detail!.submittedCount).toBe(1);
      expect(detail!.applicants.map((a) => a.applicationId).sort()).toEqual([applicationId, second.applicationId].sort());
      expect(detail!.applicants.find((a) => a.applicationId === applicationId)).toMatchObject({ firstName: "Sam", stageName: "Started" });
      expect(detail!.codes.map((c) => c.id)).toEqual([created.entryCodeId]);

      // The codes list carries the same counts.
      const code = await getEntryCode(tx, created.entryCodeId);
      expect(code).toMatchObject({ scansToday: 2, scansTotal: 3, sessionId: created.id, sessionLocation: "Shop" });
    });
  });

  it("edits a session, relabels its code and refuses an opening change once applicants are attributed", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const created = await createSession(tx, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "Shop" });
      const updated = await updateSession(tx, {
        actor,
        id: created.id,
        patch: { locationName: "Golden Valley shop", attendedCount: 18, status: "held", notes: "Room B" },
      });
      expect(updated).toMatchObject({ locationName: "Golden Valley shop", attendedCount: 18, status: "held", notes: "Room B" });
      const [code] = await tx.select().from(entryCode).where(eq(entryCode.id, created.entryCodeId));
      expect(code!.label).toBe("Session Oct 28, 2026 at Golden Valley shop");

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "group_session.update"), eq(auditLog.entityId, created.id)));
      expect(entry!.changes).toMatchObject({
        attendedCount: { from: null, to: 18 },
        status: { from: "scheduled", to: "held" },
        notes: { from: "[changed]", to: "[changed]" },
      });

      // Moving the session to another opening re-points its code while nobody is attributed.
      const [window] = await tx.select().from(opening).where(eq(opening.key, "window-2027"));
      await updateSession(tx, { actor, id: created.id, patch: { openingId: window!.id } });
      const [moved] = await tx.select().from(entryCode).where(eq(entryCode.id, created.entryCodeId));
      expect(moved!.openingId).toBe(window!.id);
      expect(moved!.roleId).toBe(window!.roleId);
      await updateSession(tx, { actor, id: created.id, patch: { openingId: snow.openingId } });

      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, snow, personId);
      await tx.update(application).set({ attributedSessionId: created.id }).where(eq(application.id, applicationId));
      await expectConfigError(updateSession(tx, { actor, id: created.id, patch: { openingId: window!.id } }), "session_has_applicants");
      expect((await updateSession(tx, { actor, id: created.id, patch: { invitedCount: 30 } })).invitedCount).toBe(30);
    });
  });

  it("entry codes: create, close, reopen and the session checks", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const flyer = await createEntryCode(tx, { actor, label: "Snow flyer, shop", channel: "flyer", roleId: snow.roleId });
      expect(flyer.openingId).toBeNull();
      expect((await resolveEntryCode(tx, flyer.code)).status).toBe("open");

      const [window] = await tx.select().from(opening).where(eq(opening.key, "window-2027"));
      await expectConfigError(
        createEntryCode(tx, { actor, label: "Wrong", channel: "flyer", roleId: snow.roleId, openingId: window!.id }),
        "opening_wrong_role",
      );
      const session = await createSession(tx, { actor, openingId: snow.openingId, startsAt: STARTS_AT, locationName: "Shop" });
      await expectConfigError(
        createEntryCode(tx, { actor, label: "No opening", channel: "session_qr", roleId: snow.roleId, groupSessionId: session.id }),
        "session_requires_opening",
      );
      await expectConfigError(createEntryCode(tx, { actor, label: " ", channel: "flyer", roleId: snow.roleId }), "invalid_input");

      const closed = await closeEntryCode(tx, { actor, id: flyer.id });
      expect(closed.closedAt).not.toBeNull();
      expect((await resolveEntryCode(tx, flyer.code)).status).toBe("closed");
      const reopened = await reopenEntryCode(tx, { actor, id: flyer.id });
      expect(reopened.closedAt).toBeNull();

      const listed = await listEntryCodes(tx);
      expect(listed.find((c) => c.id === flyer.id)).toMatchObject({ label: "Snow flyer, shop", channel: "flyer", roleName: expect.stringContaining("Snow") });
      const actions = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "entry_code"), eq(auditLog.entityId, flyer.id)));
      expect(actions.map((a) => a.action)).toEqual(["entry_code.create", "entry_code.close", "entry_code.reopen"]);
    });
  });
});
