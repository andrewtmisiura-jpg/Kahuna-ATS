import type { SessionUser } from "@/server/auth/session";

// What the profile page hands each Phase 2 panel. A panel is an async server component
// that loads its own data from applicationId, decides what this user may see, and renders
// nothing when there is nothing to show. canAct is true for Admins and Hiring Managers;
// Viewers only read. A panel's server actions still call requireRole themselves.
export type ProfilePanelProps = {
  applicationId: string;
  user: SessionUser;
  canAct: boolean;
};
