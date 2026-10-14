import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { entryCode, entryCodeScanDay, groupSession, opening, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { generateEntryCode } from "@/server/services/entry-codes";
import { centralDate } from "@/server/services/time";
import { ConfigError } from "./errors";

// Entry codes screen (DATA_MODEL.md, entry_code): create a code with a label and
// channel for a role, an opening and optionally a session; close and reopen it;
// show scans today and in total. The QR itself is built by qr.ts from the code.

export type EntryCodeRow = typeof entryCode.$inferSelect;
export type EntryChannel = EntryCodeRow["channel"];

// Channels staff may pick. staff_entered marks applications staff create by hand,
// never a printed or shared code.
export const CREATABLE_CHANNELS: { value: EntryChannel; label: string }[] = [
  { value: "role_qr", label: "Role QR code" },
  { value: "session_qr", label: "Group session QR code" },
  { value: "indeed_message", label: "Indeed message link" },
  { value: "job_posting", label: "Job posting link" },
  { value: "flyer", label: "Flyer" },
  { value: "website", label: "Website link" },
  { value: "other", label: "Other" },
];

export function channelLabel(channel: EntryChannel): string {
  return CREATABLE_CHANNELS.find((c) => c.value === channel)?.label ?? (channel === "staff_entered" ? "Staff entered" : channel);
}

export type EntryCodeListRow = {
  id: string;
  code: string;
  label: string;
  channel: EntryChannel;
  closedAt: Date | null;
  createdAt: Date;
  roleId: string;
  roleName: string;
  openingId: string | null;
  openingName: string | null;
  sessionId: string | null;
  sessionStartsAt: Date | null;
  sessionLocation: string | null;
  scansToday: number;
  scansTotal: number;
};

type ScanCounts = Map<string, { today: number; total: number }>;

// Scans today (Central date) and in total per code.
export async function loadScanCounts(db: Db, codeIds: string[], now: Date = new Date()): Promise<ScanCounts> {
  const counts: ScanCounts = new Map();
  if (codeIds.length === 0) return counts;
  const today = centralDate(now);
  const rows = await db
    .select({
      entryCodeId: entryCodeScanDay.entryCodeId,
      total: sql<number>`coalesce(sum(${entryCodeScanDay.scans}), 0)::int`,
      today: sql<number>`coalesce(sum(case when ${entryCodeScanDay.day} = ${today} then ${entryCodeScanDay.scans} else 0 end), 0)::int`,
    })
    .from(entryCodeScanDay)
    .where(inArray(entryCodeScanDay.entryCodeId, codeIds))
    .groupBy(entryCodeScanDay.entryCodeId);
  for (const row of rows) counts.set(row.entryCodeId, { today: row.today, total: row.total });
  return counts;
}

async function selectCodes(db: Db, where?: SQL) {
  return db
    .select({
      code: entryCode,
      roleName: role.internalName,
      openingName: opening.name,
      sessionStartsAt: groupSession.startsAt,
      sessionLocation: groupSession.locationName,
    })
    .from(entryCode)
    .innerJoin(role, eq(role.id, entryCode.roleId))
    .leftJoin(opening, eq(opening.id, entryCode.openingId))
    .leftJoin(groupSession, eq(groupSession.id, entryCode.groupSessionId))
    .where(where)
    .orderBy(desc(entryCode.createdAt));
}

function toListRow(
  r: { code: EntryCodeRow; roleName: string; openingName: string | null; sessionStartsAt: Date | null; sessionLocation: string | null },
  counts: ScanCounts,
): EntryCodeListRow {
  const scans = counts.get(r.code.id) ?? { today: 0, total: 0 };
  return {
    id: r.code.id,
    code: r.code.code,
    label: r.code.label,
    channel: r.code.channel,
    closedAt: r.code.closedAt,
    createdAt: r.code.createdAt,
    roleId: r.code.roleId,
    roleName: r.roleName,
    openingId: r.code.openingId,
    openingName: r.openingName,
    sessionId: r.code.groupSessionId,
    sessionStartsAt: r.sessionStartsAt,
    sessionLocation: r.sessionLocation,
    scansToday: scans.today,
    scansTotal: scans.total,
  };
}

export async function listEntryCodes(db: Db, now: Date = new Date()): Promise<EntryCodeListRow[]> {
  const rows = await selectCodes(db);
  const counts = await loadScanCounts(
    db,
    rows.map((r) => r.code.id),
    now,
  );
  return rows.map((r) => toListRow(r, counts));
}

export async function getEntryCode(db: Db, id: string, now: Date = new Date()): Promise<EntryCodeListRow | null> {
  const rows = await selectCodes(db, eq(entryCode.id, id));
  const row = rows[0];
  if (!row) return null;
  const counts = await loadScanCounts(db, [row.code.id], now);
  return toListRow(row, counts);
}

export async function listSessionEntryCodes(db: Db, sessionId: string, now: Date = new Date()): Promise<EntryCodeListRow[]> {
  const rows = await selectCodes(db, eq(entryCode.groupSessionId, sessionId));
  const counts = await loadScanCounts(
    db,
    rows.map((r) => r.code.id),
    now,
  );
  return rows.map((r) => toListRow(r, counts)).reverse();
}

// A code nobody holds yet. Collisions are checked with a select so a failed insert
// never aborts the caller's transaction; the space is 32^6, so one try almost always does.
export async function freshEntryCode(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateEntryCode(attempt < 4 ? 6 : 7);
    const [taken] = await db.select({ id: entryCode.id }).from(entryCode).where(eq(entryCode.code, code));
    if (!taken) return code;
  }
  throw new ConfigError("code_generation_failed", "Could not find a free code. Try again.");
}

export type CreateEntryCodeInput = {
  actor: Actor;
  label: string;
  channel: EntryChannel;
  roleId: string;
  openingId?: string | null;
  groupSessionId?: string | null;
};

export async function createEntryCode(db: Db, input: CreateEntryCodeInput): Promise<EntryCodeRow> {
  const label = input.label.trim();
  if (!label) throw new ConfigError("invalid_input", "Enter a label, for example where the code will be printed");
  if (label.length > 120) throw new ConfigError("invalid_input", "Keep the label under 120 characters");
  if (!CREATABLE_CHANNELS.some((c) => c.value === input.channel)) {
    throw new ConfigError("invalid_input", "Pick a channel");
  }
  const openingId = input.openingId || null;
  const groupSessionId = input.groupSessionId || null;
  if (groupSessionId && !openingId) {
    throw new ConfigError("session_requires_opening", "A session code needs its opening");
  }

  return db.transaction(async (tx) => {
    const [r] = await tx.select({ id: role.id }).from(role).where(eq(role.id, input.roleId));
    if (!r) throw new ConfigError("not_found", "No such role");
    if (openingId) {
      const [o] = await tx.select({ roleId: opening.roleId }).from(opening).where(eq(opening.id, openingId));
      if (!o) throw new ConfigError("not_found", "No such opening");
      if (o.roleId !== input.roleId) throw new ConfigError("opening_wrong_role", "That opening belongs to another role");
    }
    if (groupSessionId) {
      const [s] = await tx
        .select({ openingId: groupSession.openingId })
        .from(groupSession)
        .where(and(eq(groupSession.id, groupSessionId)));
      if (!s) throw new ConfigError("not_found", "No such session");
      if (s.openingId !== openingId) throw new ConfigError("session_wrong_opening", "That session belongs to another opening");
    }

    const code = await freshEntryCode(tx);
    const id = uuidv7();
    const [row] = await tx
      .insert(entryCode)
      .values({
        id,
        code,
        roleId: input.roleId,
        openingId,
        groupSessionId,
        channel: input.channel,
        label,
        createdBy: input.actor.type === "staff" ? input.actor.userId : null,
      })
      .returning();
    await writeAudit(tx, {
      actor: input.actor,
      action: "entry_code.create",
      entityType: "entry_code",
      entityId: id,
      changes: {
        code: { from: null, to: code },
        label: { from: null, to: label },
        channel: { from: null, to: input.channel },
        roleId: { from: null, to: input.roleId },
        openingId: { from: null, to: openingId },
        groupSessionId: { from: null, to: groupSessionId },
      },
    });
    return row!;
  });
}

async function setClosed(db: Db, actor: Actor, id: string, closed: boolean): Promise<EntryCodeRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(entryCode).where(eq(entryCode.id, id)).for("update");
    if (!before) throw new ConfigError("not_found", "No such code");
    if (Boolean(before.closedAt) === closed) return before;
    const [after] = await tx
      .update(entryCode)
      .set({ closedAt: closed ? new Date() : null })
      .where(eq(entryCode.id, id))
      .returning();
    await writeAudit(tx, {
      actor,
      action: closed ? "entry_code.close" : "entry_code.reopen",
      entityType: "entry_code",
      entityId: id,
      changes: diffChanges(before, after!, ["closedAt"]),
    });
    return after!;
  });
}

// A closed code falls back to the role page; nothing is reprinted.
export function closeEntryCode(db: Db, input: { actor: Actor; id: string }) {
  return setClosed(db, input.actor, input.id, true);
}

export function reopenEntryCode(db: Db, input: { actor: Actor; id: string }) {
  return setClosed(db, input.actor, input.id, false);
}
