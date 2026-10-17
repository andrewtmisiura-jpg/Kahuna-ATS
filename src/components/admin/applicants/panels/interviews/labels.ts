import type { AssessmentResult, InterviewBookedVia, InterviewGrade, InterviewKind, InterviewRecommendation, InterviewStatus } from "@/db/schema";
import { CENTRAL_TZ, centralParts, formatDate } from "@/server/services/time";

// Labels and small helpers for the profile's interviews panel. Times show in Central
// whatever the phone's zone, and the forms take Central dates and times.

export const KIND_LABELS: Record<InterviewKind, string> = { one_on_one: "One-on-one", phone_screen: "Phone screen" };

export const STATUS_LABELS: Record<InterviewStatus, string> = { scheduled: "Scheduled", held: "Held", no_show: "No-show", canceled: "Canceled" };

export const BOOKED_VIA_LABELS: Record<InterviewBookedVia, string> = { booking_link: "Booking link", phone: "Phone", in_person: "In person" };

export const GRADE_LABELS: Record<InterviewGrade, string> = {
  a_plus: "A+",
  a: "A",
  a_minus: "A-",
  b_plus: "B+",
  b: "B",
  b_minus: "B-",
  c_plus: "C+",
  c: "C",
  c_minus: "C-",
  d: "D",
  f: "F",
};

// Best first, the order the grade pickers list them.
export const GRADE_OPTIONS = Object.keys(GRADE_LABELS) as InterviewGrade[];

export const RECOMMENDATION_LABELS: Record<InterviewRecommendation, string> = { hire: "Hire", maybe: "Maybe", no_hire: "No hire" };

export const RESULT_LABELS: Record<AssessmentResult, string> = { pass: "Pass", fail: "Fail", did_not_attempt: "Did not attempt" };

export const NO_MEDICAL = "No medical observations: write what they said and did, never anything about health.";

const when = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// "Mon, Nov 2, 2026, 10:00 AM"
export function formatWhen(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : when.format(date);
}

// The Central date and time of an instant, as the date and time inputs want them.
export function centralInputs(value: Date | string): { date: string; time: string } {
  const p = centralParts(value instanceof Date ? value : new Date(value));
  return { date: formatDate(p.year, p.month, p.day), time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

export function staffName(user: { name: string | null; email: string } | null | undefined): string {
  return user ? (user.name ?? user.email) : "";
}

// Phone-sized tap targets, back to the usual height on wider screens.
export const TAP = "h-11 md:h-9";
