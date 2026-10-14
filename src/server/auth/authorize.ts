import { isProduction } from "@/config/env";
import type { Db } from "@/db";
import { deleteUserSessions, ensureAdminUser, findUserByEmail, findUserById } from "@/server/services/users";
import type { UserRole } from "./roles";
import type { SessionUser } from "./session";

export class NotSignedInError extends Error {
  readonly status = 401;
  constructor() {
    super("Not signed in");
    this.name = "NotSignedInError";
  }
}

export class AccessDeniedError extends Error {
  readonly status = 403;
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

// The check behind requireRole, separated from Next's request scope so it can be
// unit tested: the session names a user, the app_user row decides. Status and
// role are reloaded on every call, so disabling someone or changing their role
// takes effect at once, and a disabled user's sessions are deleted on the spot.
export async function authorizeUser(
  db: Db,
  sessionUser: SessionUser,
  allowed: UserRole | readonly UserRole[],
): Promise<SessionUser> {
  const row = sessionUser.isDevBypass ? await devBypassRow(db, sessionUser.email) : await findUserById(db, sessionUser.id);
  if (!row) throw new AccessDeniedError("No staff account for this sign-in");
  if (row.status !== "active") {
    if (!sessionUser.isDevBypass) await deleteUserSessions(db, row.id);
    throw new AccessDeniedError("This account is disabled");
  }
  const roles = typeof allowed === "string" ? [allowed] : allowed;
  if (!roles.includes(row.role)) throw new AccessDeniedError();
  return { id: row.id, email: row.email, name: row.name, role: row.role, isDevBypass: sessionUser.isDevBypass };
}

// Development only: the bypass maps DEV_AUTH_EMAIL to its app_user row, creating
// an Admin row on first use so staff actions have a real user id to write.
async function devBypassRow(db: Db, email: string) {
  if (isProduction()) throw new AccessDeniedError();
  const existing = await findUserByEmail(db, email);
  if (existing) return existing;
  console.warn(`[auth] development bypass: creating an Admin row for ${email}`);
  return (await ensureAdminUser(db, email)).user;
}
