// Display helpers shared by the list and the profile. Everything is shown in
// Central time; calendar dates (YYYY-MM-DD) are formatted from their parts so a
// browser in another zone never shifts the day.

const CENTRAL = "America/Chicago";

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dayOnly = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, month: "short", day: "numeric", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, month: "short", day: "numeric" });

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? dateTime.format(date) : "";
}

export function formatDay(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? dayOnly.format(date) : "";
}

export function formatShortDay(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? shortDay.format(date) : "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A YYYY-MM-DD calendar date as "Nov 2, 2026".
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

// The value a datetime-local input wants, in the browser's own zone. The dialog
// turns it back into an instant with new Date(value), so the browser's offset
// travels with it and no wall-clock string reaches the server.
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fullName(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last].filter(Boolean).join(" ") || "Unnamed";
}

// (612) 555-0123 for a +1 number; anything else as stored.
export function formatMobile(e164: string | null | undefined): string {
  if (!e164) return "";
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

export function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

export const STATUS_LABELS: Record<"open" | "hired" | "closed", string> = { open: "Open", hired: "Hired", closed: "Closed" };

export const OUTCOME_LABELS: Record<"disqualified" | "withdrew" | "not_selected", string> = {
  disqualified: "Disqualified",
  withdrew: "Withdrew",
  not_selected: "Not selected",
};

export const SOURCE_LABELS: Record<string, string> = {
  indeed: "Indeed",
  referral: "Referral",
  current_employee: "Works here now",
  former_employee: "Worked here before",
  social_media: "Social media",
  sign_or_walk_in: "Sign or walk-in",
  other: "Other",
};

export const ENTRY_CHANNEL_LABELS: Record<string, string> = {
  role_qr: "Role QR",
  session_qr: "Session QR",
  indeed_message: "Indeed message",
  job_posting: "Job posting",
  flyer: "Flyer",
  website: "Website",
  staff_entered: "Staff entered",
  other: "Other",
};

export const EVENT_LABELS: Record<string, string> = {
  created: "Started",
  submitted: "Submitted",
  stage_changed: "Moved",
  closed: "Closed",
  reopened: "Reopened",
  hold_set: "Put on hold",
  hold_cleared: "Hold cleared",
  contacted: "Contacted",
  hire_rescinded: "Hire rescinded",
  event_voided: "Voided an earlier entry",
  person_merged: "Person merged",
};

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  undelivered: "Undelivered",
  suppressed: "Not sent",
  canceled: "Canceled",
  received: "Received",
  unknown: "Unknown",
};

export const SUPPRESSED_REASONS: Record<string, string> = {
  do_not_contact: "do not contact",
  no_mobile: "no mobile number",
  no_email: "no email",
  suppressed: "address opted out",
  sms_disabled: "texting is off",
  sms_not_connected: "texting not connected",
  no_opt_in: "no opt-in for this number",
};

export const PURPOSE_LABELS: Record<string, string> = {
  resume_link: "Application link",
  link_recovery: "Application link again",
  reminder_24h: "Reminder",
  submit_confirmation: "Confirmation",
  help_reply: "HELP reply",
  group_invite: "Group interview invite",
  one_on_one_invite: "One-on-one invite",
  one_on_one_reminder: "One-on-one reminder",
  status_update: "Status update",
  decline: "Decline",
};

export const CONSENT_ACTION_LABELS: Record<string, string> = {
  opt_in: "Opted in",
  declined: "Box left unchecked",
  opt_out: "Opted out",
  opt_in_keyword: "Opted in by text",
};

export const CONSENT_METHOD_LABELS: Record<string, string> = {
  web_form: "application form",
  keyword: "keyword text",
  free_text_reply: "text in their own words",
  staff_recorded: "recorded by staff",
};

export const CHECK_TYPE_LABELS: Record<string, string> = {
  criminal: "Criminal",
  driving_record: "Driving record",
  drug_screen: "Drug screen",
  other: "Other",
};

export const CHECK_STATUS_LABELS: Record<string, string> = {
  requested: "Requested",
  in_progress: "In progress",
  clear: "Clear",
  needs_review: "Needs review",
  pre_adverse_sent: "Pre-adverse notice sent",
  final_adverse_sent: "Final adverse notice sent",
  canceled: "Canceled",
};

export const OFFER_RESPONSE_LABELS: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  rescinded: "Rescinded",
  expired: "Expired",
};

export const PAY_UNIT_LABELS: Record<string, string> = { hourly: "per hour", daily: "per day", salary: "salary" };

export const HIRE_OUTCOME_LABELS: Record<string, string> = {
  active: "Active",
  completed_season: "Completed season or term",
  separated: "Separated",
  never_started: "Never started",
};

export const SEASON_RATING_LABELS: Record<string, string> = {
  reliable: "Reliable",
  mixed: "Mixed",
  unreliable: "Unreliable",
  never_worked: "Never worked",
};

export const OPT_OUT_WARNING =
  "This person has opted out of texts from all Kahuna numbers. Ask them to text START to 763-292-2259 before dispatch texts will reach them.";
