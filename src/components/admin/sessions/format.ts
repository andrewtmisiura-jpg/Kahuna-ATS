import type { AttendeeSource, StarMark } from "@/db/schema";
import type { SuggestionKind } from "@/server/services/sessions/matching";

// Labels for the group session screens and the profile's attendance panel. Dates use
// the profile's Central-time formatters (applicants/format.ts); this adds the time alone.

const timeOnly = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });

// "5:58 PM" Central, for a check-in on a session whose date is already on screen.
export function formatTime(value: Date | string): string {
  return timeOnly.format(value instanceof Date ? value : new Date(value));
}

export const SOURCE_LABELS: Record<AttendeeSource, string> = {
  paper_sheet: "Sign-up sheet",
  door_checkin: "Door check-in",
  staff_added: "Added by staff",
};

export const MARK_LABELS: Record<StarMark, string> = { star: "Star", concern: "Concern" };

export const SUGGESTION_LABELS: Record<SuggestionKind, string> = {
  same_name: "same name",
  initial_and_last: "same first initial and last name",
  shared_phone: "same phone, which is marked as shared",
};

// How an attendee row came to be matched: "matched by phone" or "linked by Ann".
export function matchedHow(method: string, matchedByName: string | null): string {
  if (method === "phone_match") return "matched by phone";
  return matchedByName ? `linked by ${matchedByName}` : "linked by staff";
}

// Phone friendly tap targets: 44px tall on a phone, the usual compact size from sm up.
export const TAP = "h-11 sm:h-8";
