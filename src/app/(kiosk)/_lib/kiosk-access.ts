import { cookies } from "next/headers";
import { pageAccess, type PageAccess } from "@/components/admin/settings/page-access";
import { env } from "@/config/env";
import { db } from "@/db";
import type { UserRole } from "@/server/auth/roles";
import { getSessionUser } from "@/server/auth/session";
import type { SessionStaff } from "@/server/services/sessions/errors";
import { KIOSK_COOKIE, kioskStaff } from "@/server/services/sessions/kiosk";

// Who may use the door check-in. The kiosk page and the check-in action accept only the
// tablet's own credential for that session (sessions/kiosk.ts), never a staff session,
// so a tablet a staff member is still signed in on opens no check-in until they start
// it, which signs them out there. Staff who can act, as on the session page, start it.
export const KIOSK_ROLES: readonly UserRole[] = ["admin", "hiring_manager"];

// The staff member who started this session's kiosk on this tablet, or null.
export async function kioskAccess(sessionId: string): Promise<SessionStaff | null> {
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  return kioskStaff(db, { token, sessionId, secret: env().BETTER_AUTH_SECRET });
}

// A staff member signed in on this device, who can start the kiosk here. Anyone
// without a session goes to sign-in, the same checks as the admin pages.
export function kioskStarterAccess(): Promise<PageAccess> {
  return pageAccess(KIOSK_ROLES);
}

// Someone is signed in to the staff screens on this device, say after signing back in
// when check-in was over. The form never shows then, so a tablet is never handed over
// signed in. The development bypass signs in every request, so it does not count.
export async function staffSignedInHere(): Promise<boolean> {
  const user = await getSessionUser();
  return Boolean(user && !user.isDevBypass);
}
