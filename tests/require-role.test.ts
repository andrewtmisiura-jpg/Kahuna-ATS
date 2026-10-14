import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { appUser, authSession } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { AccessDeniedError, authorizeUser } from "@/server/auth/authorize";
import type { SessionUser } from "@/server/auth/session";
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

function session(overrides: Partial<SessionUser> = {}): SessionUser {
  return { id: adminId, email: TEST_ADMIN_EMAIL, name: null, role: "viewer", isDevBypass: false, ...overrides };
}

describe("authorizeUser", () => {
  it("takes the role from the app_user row, not the session", async () => {
    const user = await authorizeUser(db, session({ role: "viewer" }), "admin");
    expect(user.role).toBe("admin");
    expect(user.id).toBe(adminId);
    expect(user.email).toBe(TEST_ADMIN_EMAIL);
    await expect(authorizeUser(db, session(), ["admin", "hiring_manager"])).resolves.toBeDefined();
  });

  it("refuses a user whose row is missing", async () => {
    await expect(authorizeUser(db, session({ id: uuidv7(), email: "ghost@example.test" }), "admin")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("refuses the wrong role", async () => {
    await withRollback(db, async (tx) => {
      const id = uuidv7();
      await tx.insert(appUser).values({ id, email: "manager@example.test", role: "hiring_manager" });
      const me = session({ id, email: "manager@example.test" });
      await expect(authorizeUser(tx, me, "admin")).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(authorizeUser(tx, me, ["admin", "hiring_manager"])).resolves.toMatchObject({ role: "hiring_manager" });
    });
  });

  it("refuses a disabled user and ends their sessions", async () => {
    await withRollback(db, async (tx) => {
      const id = uuidv7();
      await tx.insert(appUser).values({ id, email: "leaver@example.test", role: "admin", status: "disabled" });
      await tx.insert(authSession).values({ id: uuidv7(), userId: id, token: `tok-${id}`, expiresAt: new Date(Date.now() + 86_400_000) });
      await expect(authorizeUser(tx, session({ id, email: "leaver@example.test" }), "admin")).rejects.toThrow(/disabled/);
      expect(await tx.select().from(authSession).where(eq(authSession.userId, id))).toHaveLength(0);
    });
  });

  it("maps the development bypass to the real row, creating an Admin on first use", async () => {
    const existing = await authorizeUser(db, session({ id: "dev-bypass", isDevBypass: true, role: "admin" }), "admin");
    expect(existing.id).toBe(adminId);
    expect(existing.isDevBypass).toBe(true);

    await withRollback(db, async (tx) => {
      const fresh = await authorizeUser(tx, session({ id: "dev-bypass", email: "dev@example.test", isDevBypass: true }), "admin");
      const [row] = await tx.select().from(appUser).where(eq(appUser.email, "dev@example.test"));
      expect(row!.role).toBe("admin");
      expect(fresh.id).toBe(row!.id);

      await tx.update(appUser).set({ status: "disabled" }).where(eq(appUser.id, row!.id));
      await expect(authorizeUser(tx, session({ id: "dev-bypass", email: "dev@example.test", isDevBypass: true }), "admin")).rejects.toThrow(
        /disabled/,
      );
    });
  });
});
