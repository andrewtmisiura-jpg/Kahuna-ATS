import type { UserRole } from "./roles";
import { getSessionUser, type SessionUser } from "./session";

export class NotSignedInError extends Error {
  readonly status = 401;
  constructor() {
    super("Not signed in");
  }
}

export class AccessDeniedError extends Error {
  readonly status = 403;
  constructor() {
    super("Access denied");
  }
}

// Every server action and route handler starts with this. It must never trust the
// session cookie alone: the user's status and role are reloaded from app_user on each
// call, so disabling someone or changing their role takes effect at once.
//
//   const user = await requireRole("admin");
//   const user = await requireRole(["admin", "hiring_manager"]);
export async function requireRole(allowed: UserRole | readonly UserRole[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new NotSignedInError();

  // TODO(stage 3): reload status and role from app_user by user.id (skip under the dev bypass);
  // refuse with AccessDeniedError when the row is missing or disabled, and delete that
  // user's auth_session rows so the cookie is dead too.

  const roles = typeof allowed === "string" ? [allowed] : allowed;
  if (!roles.includes(user.role)) throw new AccessDeniedError();
  return user;
}
