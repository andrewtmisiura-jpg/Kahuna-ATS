import type { ProfilePanelProps } from "./types";

// Group interview attendance (Phase 2, sessions): the sessions this applicant was signed
// in at, from the paper sheet or the door check-in, with the stars and concerns staff
// gave them and any name match waiting for a person to confirm. Renders nothing until
// the sessions build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the sessions build fills in
export async function AttendancePanel({ applicationId, user, canAct }: ProfilePanelProps) {
  return null;
}
