import { db } from "@/db";
import { authorizeUser, NotSignedInError } from "./authorize";
import type { UserRole } from "./roles";
import { getSessionUser, type SessionUser } from "./session";

export { AccessDeniedError, NotSignedInError } from "./authorize";

// Every server action and route handler starts with this; it is the only way they
// get the current user. It never trusts the session cookie alone: the user's
// status and role are reloaded from app_user on each call (authorize.ts).
//
//   const user = await requireRole("admin");
//   const user = await requireRole(["admin", "hiring_manager"]);
export async function requireRole(allowed: UserRole | readonly UserRole[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new NotSignedInError();
  return authorizeUser(db, user, allowed);
}
