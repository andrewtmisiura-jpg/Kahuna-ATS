import type { UserRole } from "@/server/auth/roles";

// Errors raised by the group session services (attendees, matching, stars and the
// door check-in), and who may change those rows. Each error carries a code the
// server actions pass on with a plain sentence.

export type SessionErrorCode =
  | "not_allowed"
  | "session_not_found"
  | "session_canceled"
  | "attendee_not_found"
  | "application_not_found"
  | "name_required"
  | "name_too_long"
  | "invalid_source"
  | "invalid_mobile"
  | "mobile_on_list"
  | "wrong_opening"
  | "already_matched"
  | "application_on_list"
  | "not_matched"
  | "checkin_closed"
  | "invalid_reason"
  | "reason_required"
  | "note_required"
  | "note_too_long";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

// Admins and Hiring Managers act on attendees and stars; Viewers only read them.
export const SESSION_STAFF_ROLES: readonly UserRole[] = ["admin", "hiring_manager"];

// The signed-in staff member behind a write, as requireRole returned them. The
// services check the role again, so a Viewer is refused even if an action forgets.
export type SessionStaff = { userId: string; role: UserRole };

export function assertCanAct(staff: SessionStaff) {
  if (!SESSION_STAFF_ROLES.includes(staff.role)) {
    throw new SessionError("not_allowed", "Only Admins and Hiring Managers can change attendees and stars");
  }
}
