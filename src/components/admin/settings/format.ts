import { CENTRAL_TZ } from "@/server/services/time";

// Display formatting for the configuration screens. Instants are shown in Central
// time whatever the browser's zone; calendar dates are the YYYY-MM-DD strings the
// date columns hold.

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatCentralDateTime(instant: Date | null | undefined): string {
  return instant ? dateTime.format(instant) : "";
}

export function formatCentralDate(instant: Date | null | undefined): string {
  return instant ? dateOnly.format(instant) : "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-23" to "Oct 23, 2026", without going through a time zone.
export function formatDateOnly(date: string | null | undefined): string {
  if (!date) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

export function fullName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ") || "(name removed)";
}
