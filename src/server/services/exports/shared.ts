import { and, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { opening, role } from "@/db/schema";
import type { CsvCell } from "../csv";
import { addDays, centralOffsetMinutes, centralParts, parseDate, startOfCentralDay } from "../time";

// Shared pieces of the CSV export set (DATA_MODEL.md, "CSV export set"): the
// filters every export accepts, the error class the route maps to HTTP, and the
// cell formatters. Timestamps are written in Central time with the offset spelled
// out (2026-10-20T11:00:00-05:00), so a sheet reads them the way staff think and
// nothing is ambiguous across the Nov 1 change.

export type ExportFilters = {
  openingId?: string | null;
  // Central calendar dates, YYYY-MM-DD, both ends inclusive.
  from?: string | null;
  to?: string | null;
};

export type ExportErrorCode = "unknown_export" | "opening_required" | "opening_not_found" | "bad_date" | "bad_date_range";

const STATUS_FOR_CODE: Record<ExportErrorCode, number> = {
  unknown_export: 404,
  opening_required: 400,
  opening_not_found: 404,
  bad_date: 400,
  bad_date_range: 400,
};

export class ExportError extends Error {
  readonly status: number;
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
    this.status = STATUS_FOR_CODE[code];
  }
}

export type ExportTable = { headers: string[]; rows: CsvCell[][] };

export type OpeningRef = { id: string; key: string; name: string; roleId: string; roleKey: string };

export type DateRange = {
  from: string | null;
  to: string | null;
  fromInstant: Date | null;
  // The start of the Central day after `to`, so a timestamp range is half-open.
  toExclusiveInstant: Date | null;
};

// What every export function receives: the validated filters, resolved once.
export type ExportContext = { filters: ExportFilters; opening: OpeningRef | null; range: DateRange };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(value: string | null | undefined, which: "from" | "to"): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!DATE_PATTERN.test(trimmed)) throw new ExportError("bad_date", `The ${which} date must look like 2026-10-23`);
  const { year, month, day } = parseDate(trimmed);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ExportError("bad_date", `${trimmed} is not a real date`);
  }
  return trimmed;
}

export function parseDateRange(filters: ExportFilters): DateRange {
  const from = cleanDate(filters.from, "from");
  const to = cleanDate(filters.to, "to");
  if (from && to && from > to) throw new ExportError("bad_date_range", "The from date must not be after the to date");
  return {
    from,
    to,
    fromInstant: from ? startOfCentralDay(from) : null,
    toExclusiveInstant: to ? startOfCentralDay(addDays(to, 1)) : null,
  };
}

export async function resolveOpening(db: Db, openingId: string | null | undefined): Promise<OpeningRef | null> {
  const id = openingId?.trim();
  if (!id) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ExportError("opening_not_found", "No such opening");
  }
  const [row] = await db
    .select({ id: opening.id, key: opening.key, name: opening.name, roleId: opening.roleId, roleKey: role.key })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .where(eq(opening.id, id));
  if (!row) throw new ExportError("opening_not_found", "No such opening");
  return row;
}

// A timestamptz column inside the Central day range (half-open at the end).
export function timestampRange(column: AnyPgColumn, range: DateRange): SQL | undefined {
  const conditions: SQL[] = [];
  if (range.fromInstant) conditions.push(gte(column, range.fromInstant));
  if (range.toExclusiveInstant) conditions.push(lt(column, range.toExclusiveInstant));
  return conditions.length ? and(...conditions) : undefined;
}

// A date column inside the range (calendar dates compare as strings).
export function dayRange(column: AnyPgColumn, range: DateRange): SQL | undefined {
  const conditions: SQL[] = [];
  if (range.from) conditions.push(gte(column, range.from));
  if (range.to) conditions.push(lte(column, range.to));
  return conditions.length ? and(...conditions) : undefined;
}

export function openingFilter(column: AnyPgColumn, ctx: ExportContext): SQL | undefined {
  return ctx.opening ? eq(column, ctx.opening.id) : undefined;
}

export function inRange(instant: Date, range: DateRange): boolean {
  if (range.fromInstant && instant.getTime() < range.fromInstant.getTime()) return false;
  if (range.toExclusiveInstant && instant.getTime() >= range.toExclusiveInstant.getTime()) return false;
  return true;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// ISO 8601 in Central time with the offset: 2026-10-20T11:00:00-05:00.
export function centralIso(instant: Date | null | undefined): string {
  if (!instant) return "";
  const p = centralParts(instant);
  const offset = centralOffsetMinutes(instant);
  const abs = Math.abs(offset);
  const sign = offset < 0 ? "-" : "+";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function jsonCell(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

export function boolCell(value: boolean | null | undefined): string {
  return value === null || value === undefined ? "" : value ? "true" : "false";
}

export function listCell(values: readonly string[] | null | undefined): string {
  return values && values.length ? values.join("; ") : "";
}

// Runs a query per chunk of ids so an `in (...)` list never grows past what the
// driver sends in one statement.
export async function inChunks<T, R>(ids: readonly T[], fn: (chunk: T[]) => Promise<R[]>, size = 1000): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(...(await fn(ids.slice(i, i + size))));
  }
  return out;
}

// Application links are stored as {link:<token id>}; staff never see a usable link.
export const LINK_DISPLAY = "[application link]";

export function displayBody(body: string | null | undefined): string {
  return (body ?? "").replace(/\{link(?::[0-9a-f-]{36})?\}/g, LINK_DISPLAY);
}
