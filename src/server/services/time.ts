// The single Central-time helper (DATA_MODEL.md, "UTC storage, Central reporting").
// Everything is stored in UTC; quiet hours, calendar days, business days and day
// bucketing are computed here in America/Chicago, never from the host time zone.
// Calendar dates are plain "YYYY-MM-DD" strings, the same shape Drizzle returns
// for date columns.

export const CENTRAL_TZ = "America/Chicago";

// Texts the applicant did not just ask for go out between 9:00 and 20:00 Central.
export const SEND_WINDOW = { startHour: 9, endHour: 20 } as const;

export type CentralParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  // 0 = Sunday, 6 = Saturday.
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

export function centralParts(instant: Date): CentralParts {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU versions print midnight as 24 with hourCycle h23.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function formatDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// The Central calendar date an instant falls on.
export function centralDate(instant: Date): string {
  const p = centralParts(instant);
  return formatDate(p.year, p.month, p.day);
}

// Central's offset from UTC at that instant, in minutes (-300 in summer, -360 in winter).
export function centralOffsetMinutes(instant: Date): number {
  const p = centralParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

// The instant at a Central wall-clock time. Resolves the offset twice so the day
// after a daylight saving change gets the new offset. During the repeated hour on
// a fall-back night the later (standard time) reading wins; during the skipped
// hour on a spring-forward night the result lands after the gap.
export function centralInstant(date: string, hour = 0, minute = 0): Date {
  const { year, month, day } = parseDate(date);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = new Date(wall - centralOffsetMinutes(new Date(wall)) * 60_000);
  const offset = centralOffsetMinutes(firstGuess);
  return new Date(wall - offset * 60_000);
}

export function startOfCentralDay(date: string): Date {
  return centralInstant(date, 0, 0);
}

// Calendar arithmetic on dates, independent of time zones and DST.
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Central calendar dates subtracted: to minus from, in whole days.
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Business days are weekdays; there is no holiday table (PLAN.md, Decisions).
export function isWeekday(date: string): boolean {
  const w = weekdayOf(date);
  return w !== 0 && w !== 6;
}

// The date that is `count` weekdays after `date` (count >= 0). Five weekdays after
// a Monday is the next Monday; one weekday after a Saturday is the Monday.
export function addWeekdays(date: string, count: number): string {
  if (count < 0) throw new Error("addWeekdays counts forward only");
  let current = date;
  let remaining = count;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (isWeekday(current)) remaining -= 1;
  }
  return current;
}

// Weekdays strictly after `from` up to and including `to`; 0 when `to` is not later.
export function weekdaysBetween(from: string, to: string): number {
  if (daysBetween(from, to) <= 0) return 0;
  let count = 0;
  let current = from;
  while (current !== to) {
    current = addDays(current, 1);
    if (isWeekday(current)) count += 1;
  }
  return count;
}

// True between 9:00 (inclusive) and 20:00 (exclusive) Central.
export function isInSendWindow(instant: Date): boolean {
  const { hour } = centralParts(instant);
  return hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

// The instant itself inside the window; otherwise the next 9:00 Central.
export function nextSendWindowStart(instant: Date): Date {
  if (isInSendWindow(instant)) return instant;
  const p = centralParts(instant);
  const today = formatDate(p.year, p.month, p.day);
  const date = p.hour < SEND_WINDOW.startHour ? today : addDays(today, 1);
  return centralInstant(date, SEND_WINDOW.startHour, 0);
}

// Hour bucket for dedupe keys such as alert:<kind>:<hour>, in UTC.
export function hourBucket(instant: Date): string {
  return instant.toISOString().slice(0, 13);
}
