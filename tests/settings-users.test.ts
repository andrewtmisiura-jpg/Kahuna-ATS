import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { appUser, auditLog, authSession } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { ConfigError } from "@/server/services/config/errors";
import { addUser, changeUserRole, disableUser, enableUser, listUsers } from "@/server/services/config/users-admin";
import { withRollback } from "./helpers/db";
import { loadAdminId, TEST_ADMIN_EMAIL } from "./helpers/fixtures";

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

async function expectConfigError(run: Promise<unknown>, code: ConfigError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof ConfigError && error.code === code);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function sessionsFor(tx: Tx, userId: string) {
  return tx.select({ id: authSession.id }).from(authSession).where(eq(authSession.userId, userId));
}

async function addSession(tx: Tx, userId: string) {
  await tx.insert(authSession).values({ id: uuidv7(), userId, token: `tok-${uuidv7()}`, expiresAt: new Date(Date.now() + 86_400_000) });
}

describe("Settings > Users", () => {
  it("adds an email with a role, lowercased, and refuses duplicates and bad input", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const user = await addUser(tx, { actor, email: " Manager@Example.test ", role: "hiring_manager" });
      expect(user.email).toBe("manager@example.test");
      expect(user.role).toBe("hiring_manager");
      expect(user.status).toBe("active");
      expect(user.invitedBy).toBe(adminId);
      expect(user.googleSub).toBeNull();

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "app_user"), eq(auditLog.entityId, user.id)));
      expect(entry!.action).toBe("user.add");
      expect(entry!.changes).toMatchObject({ role: { from: null, to: "hiring_manager" } });

      await expectConfigError(addUser(tx, { actor, email: "manager@example.test", role: "admin" }), "user_exists");
      await expectConfigError(addUser(tx, { actor, email: "not-an-email", role: "admin" }), "invalid_input");
      await expectConfigError(addUser(tx, { actor, email: "viewer@example.test", role: "viewer" }), "invalid_input");
      expect((await listUsers(tx)).map((u) => u.email)).toContain("manager@example.test");
    });
  });

  it("disabling a user ends their sessions at once and is audited", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const leaver = await addUser(tx, { actor, email: "leaver@example.test", role: "hiring_manager" });
      await addSession(tx, leaver.id);
      await addSession(tx, leaver.id);
      expect(await sessionsFor(tx, leaver.id)).toHaveLength(2);

      const disabled = await disableUser(tx, { actor, userId: leaver.id });
      expect(disabled.status).toBe("disabled");
      expect(await sessionsFor(tx, leaver.id)).toHaveLength(0);

      const entries = await tx
        .select({ action: auditLog.action, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "app_user"), eq(auditLog.entityId, leaver.id)));
      // No ORDER BY: Postgres may return the rows in either order, so match by action.
      expect(entries.map((e) => e.action).sort()).toEqual(["user.add", "user.disable"]);
      expect(entries.find((e) => e.action === "user.disable")!.changes).toEqual({ status: { from: "active", to: "disabled" } });

      // Disabling again changes nothing; re-enabling brings them back without a session.
      expect((await disableUser(tx, { actor, userId: leaver.id })).status).toBe("disabled");
      const enabled = await enableUser(tx, { actor, userId: leaver.id });
      expect(enabled.status).toBe("active");
      expect(await sessionsFor(tx, leaver.id)).toHaveLength(0);
    });
  });

  it("nobody can disable themselves or change their own role", async () => {
    const actor = staffActor(adminId);
    await expectConfigError(disableUser(db, { actor, userId: adminId }), "cannot_disable_self");
    await expectConfigError(changeUserRole(db, { actor, userId: adminId, role: "hiring_manager" }), "cannot_change_own_role");
    const [row] = await db.select().from(appUser).where(eq(appUser.id, adminId));
    expect(row!.status).toBe("active");
    expect(row!.role).toBe("admin");
  });

  it("keeps at least one active Admin", async () => {
    await withRollback(db, async (tx) => {
      const other = await addUser(tx, { actor: staffActor(adminId), email: "second@example.test", role: "hiring_manager" });
      const otherActor = staffActor(other.id);
      // The seeded Admin is the only active Admin, so it cannot be disabled or demoted.
      await expectConfigError(disableUser(tx, { actor: otherActor, userId: adminId }), "last_admin");
      await expectConfigError(changeUserRole(tx, { actor: otherActor, userId: adminId, role: "hiring_manager" }), "last_admin");

      await changeUserRole(tx, { actor: staffActor(adminId), userId: other.id, role: "admin" });
      const demoted = await changeUserRole(tx, { actor: otherActor, userId: adminId, role: "hiring_manager" });
      expect(demoted.role).toBe("hiring_manager");
    });
  });

  it("changing a role ends sessions and audits the grant", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const user = await addUser(tx, { actor, email: "promote@example.test", role: "hiring_manager" });
      await addSession(tx, user.id);
      const promoted = await changeUserRole(tx, { actor, userId: user.id, role: "admin" });
      expect(promoted.role).toBe("admin");
      expect(await sessionsFor(tx, user.id)).toHaveLength(0);
      const entries = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "app_user"), eq(auditLog.entityId, user.id)));
      expect(entries.map((e) => e.action)).toEqual(["user.add", "user.role_grant"]);
      // Same role again is a no-op.
      expect((await changeUserRole(tx, { actor, userId: user.id, role: "admin" })).role).toBe("admin");
      await expectConfigError(changeUserRole(tx, { actor, userId: uuidv7(), role: "admin" }), "not_found");
    });
  });
});
