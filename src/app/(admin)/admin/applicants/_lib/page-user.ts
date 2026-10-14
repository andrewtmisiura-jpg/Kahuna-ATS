import { redirect } from "next/navigation";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";

export const REVIEW_ROLES: readonly UserRole[] = ["admin", "hiring_manager", "viewer"];

// The review pages read data, so they go through requireRole like an action
// does: the role comes from app_user, not the cookie. A missing session goes to
// sign-in; a disabled or unknown account gets null and the page says so.
export async function pageUser(roles: readonly UserRole[] = REVIEW_ROLES): Promise<SessionUser | null> {
  try {
    return await requireRole(roles);
  } catch (error) {
    if (error instanceof NotSignedInError) redirect("/admin/sign-in");
    if (error instanceof AccessDeniedError) return null;
    throw error;
  }
}

export function canAct(user: SessionUser): boolean {
  return user.role === "admin" || user.role === "hiring_manager";
}
