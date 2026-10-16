import { pageAccess, type PageAccess } from "@/components/admin/settings/page-access";
import type { UserRole } from "@/server/auth/roles";

// Who may open the door check-in: staff who can act, as on the session page. Anyone
// without a session goes to sign-in, the same checks as the admin pages (pageAccess,
// then requireRole). The layout and every kiosk page call it, because a layout does not
// stop the page under it from rendering.
export const KIOSK_ROLES: readonly UserRole[] = ["admin", "hiring_manager"];

export function kioskAccess(): Promise<PageAccess> {
  return pageAccess(KIOSK_ROLES);
}
