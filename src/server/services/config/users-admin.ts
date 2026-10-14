import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { appUser } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { writeAudit } from "@/server/services/audit";
import { deleteUserSessions, findUserByEmail, findUserById, normalizeEmail, type AppUser } from "@/server/services/users";
import { ConfigError, PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors";

// Settings > Users (DATA_MODEL.md, app_user): the sign-in allowlist. An Admin adds
// an email with a role, changes roles, disables (the only offboarding; sessions end
// at once) and re-enables. Grants and revokes go to audit_log. Viewer stays in the
// enum but is not offered until someone needs it.

export const ASSIGNABLE_ROLES = ["admin", "hiring_manager"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const emailSchema = z.email();

export async function listUsers(db: Db): Promise<AppUser[]> {
  return db.select().from(appUser).orderBy(asc(appUser.status), asc(appUser.role), asc(appUser.email));
}

function toAssignable(role: string): AssignableRole {
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    throw new ConfigError("invalid_input", "Role must be Admin or Hiring Manager");
  }
  return role as AssignableRole;
}

function actorUserId(actor: Actor): string | null {
  return actor.type === "staff" ? actor.userId : null;
}

export async function addUser(db: Db, input: { actor: Actor; email: string; role: string }): Promise<AppUser> {
  const role = toAssignable(input.role);
  const parsed = emailSchema.safeParse(normalizeEmail(input.email));
  if (!parsed.success) throw new ConfigError("invalid_input", "Enter a valid email address");
  const email = parsed.data;

  return db.transaction(async (tx) => {
    const existing = await findUserByEmail(tx, email);
    if (existing) {
      const hint = existing.status === "disabled" ? " It is disabled; re-enable it instead." : "";
      throw new ConfigError("user_exists", `${email} is already on the list.${hint}`);
    }
    const id = uuidv7();
    let user: AppUser;
    try {
      [user] = (await tx
        .insert(appUser)
        .values({ id, email, role, status: "active", invitedBy: actorUserId(input.actor) })
        .returning()) as [AppUser];
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new ConfigError("user_exists", `${email} is already on the list.`);
      throw error;
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "user.add",
      entityType: "app_user",
      entityId: id,
      changes: { role: { from: null, to: role }, status: { from: null, to: "active" } },
    });
    return user;
  });
}

async function loadUser(db: Db, userId: string): Promise<AppUser> {
  const user = await findUserById(db, userId);
  if (!user) throw new ConfigError("not_found", "No such user");
  return user;
}

// True when `userId` is the only active Admin, so disabling or demoting them would
// lock everyone out of Settings.
async function isLastActiveAdmin(db: Db, userId: string): Promise<boolean> {
  const others = await db
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.role, "admin"), eq(appUser.status, "active"), ne(appUser.id, userId)))
    .limit(1);
  return others.length === 0;
}

// Changing a role ends the user's sessions so the new role applies on their next sign-in.
export async function changeUserRole(db: Db, input: { actor: Actor; userId: string; role: string }): Promise<AppUser> {
  const role = toAssignable(input.role);
  if (actorUserId(input.actor) === input.userId) {
    throw new ConfigError("cannot_change_own_role", "You cannot change your own role. Ask another Admin.");
  }
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    if (before.role === role) return before;
    if (before.role === "admin" && before.status === "active" && (await isLastActiveAdmin(tx, before.id))) {
      throw new ConfigError("last_admin", "This is the only active Admin. Add another Admin first.");
    }
    const [after] = await tx.update(appUser).set({ role }).where(eq(appUser.id, before.id)).returning();
    await deleteUserSessions(tx, before.id);
    await writeAudit(tx, {
      actor: input.actor,
      action: role === "admin" ? "user.role_grant" : "user.role_change",
      entityType: "app_user",
      entityId: before.id,
      changes: { role: { from: before.role, to: role } },
    });
    return after!;
  });
}

// Disabling is the offboarding step: the row stays, sign-in is refused and every
// session row is deleted now. Nobody can disable themselves.
export async function disableUser(db: Db, input: { actor: Actor; userId: string }): Promise<AppUser> {
  if (actorUserId(input.actor) === input.userId) {
    throw new ConfigError("cannot_disable_self", "You cannot disable your own account. Ask another Admin.");
  }
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    if (before.status === "disabled") return before;
    if (before.role === "admin" && (await isLastActiveAdmin(tx, before.id))) {
      throw new ConfigError("last_admin", "This is the only active Admin. Add another Admin first.");
    }
    const [after] = await tx.update(appUser).set({ status: "disabled" }).where(eq(appUser.id, before.id)).returning();
    await deleteUserSessions(tx, before.id);
    await writeAudit(tx, {
      actor: input.actor,
      action: "user.disable",
      entityType: "app_user",
      entityId: before.id,
      changes: { status: { from: "active", to: "disabled" } },
    });
    return after!;
  });
}

export async function enableUser(db: Db, input: { actor: Actor; userId: string }): Promise<AppUser> {
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    if (before.status === "active") return before;
    const [after] = await tx.update(appUser).set({ status: "active" }).where(eq(appUser.id, before.id)).returning();
    await writeAudit(tx, {
      actor: input.actor,
      action: "user.enable",
      entityType: "app_user",
      entityId: before.id,
      changes: { status: { from: "disabled", to: "active" } },
    });
    return after!;
  });
}
