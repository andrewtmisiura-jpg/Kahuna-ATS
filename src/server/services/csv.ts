import { parsePhoneNumberFromString } from "libphonenumber-js";

// CSV export writer (DATA_MODEL.md, "CSV export set"). Any cell whose first
// non-space character could start a spreadsheet formula gets an apostrophe
// prefix, in every column including headers; every field is quoted and embedded
// quotes are doubled (RFC 4180). UTF-8, CRLF line endings.

const FORMULA_STARTERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export type CsvCell = string | number | boolean | Date | null | undefined;

export function escapeFormula(value: string): string {
  const first = value.replace(/^ +/, "")[0];
  return first !== undefined && FORMULA_STARTERS.has(first) ? `'${value}` : value;
}

function cellText(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function csvCell(value: CsvCell): string {
  const text = escapeFormula(cellText(value));
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: readonly CsvCell[]): string {
  return cells.map(csvCell).join(",");
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  return `${lines.join("\r\n")}\r\n`;
}

// Phone numbers export in national format, (612) 555-0123, so they need no apostrophe.
export function formatPhoneNational(e164: string | null | undefined): string {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatNational() : e164;
}
