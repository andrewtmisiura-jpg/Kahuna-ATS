import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { entryCode, entryCodeScanDay, groupSession, opening, role } from "@/db/schema";
import { ENTRY_CODE_PATTERN } from "@/db/schema/columns";
import { centralDate } from "./time";

// Entry codes (DATA_MODEL.md, entry_code): the short code inside every QR or link,
// resolved to an opening and optional session at scan time. A closed code, or one
// whose opening is no longer open, falls back to the role page.

type EntryCodeRow = typeof entryCode.$inferSelect;
type RoleRow = typeof role.$inferSelect;
type OpeningRow = typeof opening.$inferSelect;
type SessionRow = typeof groupSession.$inferSelect;

export type EntryCodeResolution =
  | { status: "open"; entryCode: EntryCodeRow; role: RoleRow; opening: OpeningRow; session: SessionRow | null }
  // The code is closed or its opening is not open: show the role page for whichever
  // opening of the role is open, or "not accepting applications" when none is.
  | { status: "closed"; entryCode: EntryCodeRow; role: RoleRow; opening: OpeningRow | null }
  | { status: "not_found" };

const CODE_REGEX = new RegExp(ENTRY_CODE_PATTERN);

// Codes are uppercase Crockford base32 without I, L, O or U; the user may type them in lowercase.
export function normalizeEntryCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return CODE_REGEX.test(code) ? code : null;
}

export async function resolveEntryCode(db: Db, rawCode: string): Promise<EntryCodeResolution> {
  const code = normalizeEntryCode(rawCode);
  if (!code) return { status: "not_found" };
  const [row] = await db.select().from(entryCode).where(eq(entryCode.code, code));
  if (!row) return { status: "not_found" };
  const [codeRole] = await db.select().from(role).where(eq(role.id, row.roleId));
  if (!codeRole) return { status: "not_found" };

  const openOpening = async () => {
    const [found] = await db
      .select()
      .from(opening)
      .where(and(eq(opening.roleId, row.roleId), eq(opening.status, "open")));
    return found ?? null;
  };

  if (row.closedAt || codeRole.archivedAt) {
    return { status: "closed", entryCode: row, role: codeRole, opening: await openOpening() };
  }

  let target: OpeningRow | null;
  if (row.openingId) {
    const [pinned] = await db.select().from(opening).where(eq(opening.id, row.openingId));
    target = pinned && pinned.status === "open" ? pinned : null;
    if (!target) return { status: "closed", entryCode: row, role: codeRole, opening: await openOpening() };
  } else {
    target = await openOpening();
    if (!target) return { status: "closed", entryCode: row, role: codeRole, opening: null };
  }

  let session: SessionRow | null = null;
  if (row.groupSessionId) {
    const [found] = await db.select().from(groupSession).where(eq(groupSession.id, row.groupSessionId));
    session = found && !found.deletedAt ? found : null;
  }
  return { status: "open", entryCode: row, role: codeRole, opening: target, session };
}

// Anonymous daily scan counter: one upsert per scan, keyed by the Central date.
export async function recordScan(db: Db, entryCodeId: string, now: Date = new Date()): Promise<void> {
  await db
    .insert(entryCodeScanDay)
    .values({ entryCodeId, day: centralDate(now), scans: 1 })
    .onConflictDoUpdate({
      target: [entryCodeScanDay.entryCodeId, entryCodeScanDay.day],
      set: { scans: sql`${entryCodeScanDay.scans} + 1` },
    });
}

export const ENTRY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// A fresh random code for Settings > Entry codes; the caller retries on a unique collision.
export function generateEntryCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ENTRY_CODE_ALPHABET[Math.floor(Math.random() * ENTRY_CODE_ALPHABET.length)];
  }
  return code;
}
