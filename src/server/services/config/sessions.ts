import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application, entryCode, entryCodeScanDay, groupSession, opening, person, pipelineStage, role, type GroupInterviewArrival } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { centralDate, centralParts } from "@/server/services/time";
import { createEntryCode, listSessionEntryCodes, type EntryCodeListRow } from "./entry-codes-admin";
import { ConfigError } from "./errors";

// Group interview sessions (DATA_MODEL.md, group_session; PLAN.md, Phase 1 "group
// sessions"): the session record, a per-session QR (created with the session so it
// is ready at once) and the applicants attributed to it. Attendees and stars follow
// in Phase 2.

export type SessionRow = typeof groupSession.$inferSelect;
export type SessionStatus = SessionRow["status"];

export const SESSION_STATUSES: { value: SessionStatus; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "held", label: "Held" },
  { value: "canceled", label: "Canceled" },
];

export type SessionCode = { id: string; code: string; closedAt: Date | null };

export type SessionListRow = {
  id: string;
  openingId: string;
  openingName: string;
  roleId: string;
  roleName: string;
  startsAt: Date;
  locationName: string;
  locationAddress: string | null;
  invitedCount: number | null;
  attendedCount: number | null;
  status: SessionStatus;
  notes: string | null;
  createdAt: Date;
  // The session's own QR code (channel session_qr), or null if it was never made.
  code: SessionCode | null;
  scansToday: number;
  scansTotal: number;
  startedCount: number;
  submittedCount: number;
};

export type SessionApplicant = {
  applicationId: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  stageName: string;
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  // Marked from the session page right after the group interview.
  groupInterviewArrival: GroupInterviewArrival | null;
};

export type SessionDetail = SessionListRow & { applicants: SessionApplicant[]; codes: EntryCodeListRow[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The label the session's entry code carries, e.g. "Session Oct 28, 2026 at Golden Valley shop".
export function sessionCodeLabel(startsAt: Date, locationName: string): string {
  const p = centralParts(startsAt);
  return `Session ${MONTHS[p.month - 1]} ${p.day}, ${p.year} at ${locationName}`;
}

type Enrichment = {
  codes: Map<string, SessionCode>;
  scans: Map<string, { today: number; total: number }>;
  applicants: Map<string, { started: number; submitted: number }>;
};

async function enrich(db: Db, sessionIds: string[], now: Date): Promise<Enrichment> {
  const result: Enrichment = { codes: new Map(), scans: new Map(), applicants: new Map() };
  if (sessionIds.length === 0) return result;

  const codeRows = await db
    .select({ id: entryCode.id, code: entryCode.code, closedAt: entryCode.closedAt, sessionId: entryCode.groupSessionId })
    .from(entryCode)
    .where(and(inArray(entryCode.groupSessionId, sessionIds), eq(entryCode.channel, "session_qr")))
    .orderBy(asc(entryCode.createdAt));
  for (const row of codeRows) {
    if (row.sessionId && !result.codes.has(row.sessionId)) {
      result.codes.set(row.sessionId, { id: row.id, code: row.code, closedAt: row.closedAt });
    }
  }

  const today = centralDate(now);
  const scanRows = await db
    .select({
      sessionId: entryCode.groupSessionId,
      total: sql<number>`coalesce(sum(${entryCodeScanDay.scans}), 0)::int`,
      today: sql<number>`coalesce(sum(case when ${entryCodeScanDay.day} = ${today} then ${entryCodeScanDay.scans} else 0 end), 0)::int`,
    })
    .from(entryCodeScanDay)
    .innerJoin(entryCode, eq(entryCode.id, entryCodeScanDay.entryCodeId))
    .where(inArray(entryCode.groupSessionId, sessionIds))
    .groupBy(entryCode.groupSessionId);
  for (const row of scanRows) {
    if (row.sessionId) result.scans.set(row.sessionId, { today: row.today, total: row.total });
  }

  const appRows = await db
    .select({
      sessionId: application.attributedSessionId,
      started: sql<number>`count(*)::int`,
      submitted: sql<number>`count(${application.submittedAt})::int`,
    })
    .from(application)
    .where(and(inArray(application.attributedSessionId, sessionIds), isNull(application.deletedAt)))
    .groupBy(application.attributedSessionId);
  for (const row of appRows) {
    if (row.sessionId) result.applicants.set(row.sessionId, { started: row.started, submitted: row.submitted });
  }
  return result;
}

type JoinedRow = { session: SessionRow; openingName: string; roleId: string; roleName: string };

function toListRow(r: JoinedRow, e: Enrichment): SessionListRow {
  const scans = e.scans.get(r.session.id) ?? { today: 0, total: 0 };
  const apps = e.applicants.get(r.session.id) ?? { started: 0, submitted: 0 };
  return {
    id: r.session.id,
    openingId: r.session.openingId,
    openingName: r.openingName,
    roleId: r.roleId,
    roleName: r.roleName,
    startsAt: r.session.startsAt,
    locationName: r.session.locationName,
    locationAddress: r.session.locationAddress,
    invitedCount: r.session.invitedCount,
    attendedCount: r.session.attendedCount,
    status: r.session.status,
    notes: r.session.notes,
    createdAt: r.session.createdAt,
    code: e.codes.get(r.session.id) ?? null,
    scansToday: scans.today,
    scansTotal: scans.total,
    startedCount: apps.started,
    submittedCount: apps.submitted,
  };
}

function joined(db: Db) {
  return db
    .select({ session: groupSession, openingName: opening.name, roleId: role.id, roleName: role.internalName })
    .from(groupSession)
    .innerJoin(opening, eq(opening.id, groupSession.openingId))
    .innerJoin(role, eq(role.id, opening.roleId));
}

export async function listSessions(db: Db, now: Date = new Date()): Promise<SessionListRow[]> {
  const rows = await joined(db).where(isNull(groupSession.deletedAt)).orderBy(desc(groupSession.startsAt));
  const e = await enrich(
    db,
    rows.map((r) => r.session.id),
    now,
  );
  return rows.map((r) => toListRow(r, e));
}

export async function getSession(db: Db, id: string, now: Date = new Date()): Promise<SessionDetail | null> {
  const rows = await joined(db).where(and(eq(groupSession.id, id), isNull(groupSession.deletedAt)));
  const row = rows[0];
  if (!row) return null;
  const e = await enrich(db, [id], now);
  const applicants = await db
    .select({
      applicationId: application.id,
      personId: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      stageName: pipelineStage.name,
      status: application.status,
      startedAt: application.startedAt,
      submittedAt: application.submittedAt,
      groupInterviewArrival: application.groupInterviewArrival,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .where(and(eq(application.attributedSessionId, id), isNull(application.deletedAt)))
    .orderBy(desc(application.submittedAt), desc(application.startedAt));
  const codes = await listSessionEntryCodes(db, id, now);
  return { ...toListRow(row, e), applicants, codes };
}

export type SessionFields = {
  openingId: string;
  startsAt: Date;
  locationName: string;
  locationAddress: string | null;
  invitedCount: number | null;
  attendedCount: number | null;
  notes: string | null;
  status: SessionStatus;
};

function cleanCount(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new ConfigError("invalid_input", `${field} must be a whole number`);
  return value;
}

function cleanFields(fields: SessionFields): SessionFields {
  const locationName = fields.locationName.trim();
  if (!locationName) throw new ConfigError("invalid_input", "Enter where the session is held");
  if (locationName.length > 120) throw new ConfigError("invalid_input", "Keep the location name under 120 characters");
  if (!(fields.startsAt instanceof Date) || Number.isNaN(fields.startsAt.getTime())) {
    throw new ConfigError("invalid_input", "Enter the date and time");
  }
  if (!SESSION_STATUSES.some((s) => s.value === fields.status)) throw new ConfigError("invalid_input", "Pick a status");
  return {
    openingId: fields.openingId,
    startsAt: fields.startsAt,
    locationName,
    locationAddress: fields.locationAddress?.trim() || null,
    invitedCount: cleanCount(fields.invitedCount, "Invited count"),
    attendedCount: cleanCount(fields.attendedCount, "Attended count"),
    notes: fields.notes?.trim() || null,
    status: fields.status,
  };
}

async function loadOpenOrDraftOpening(db: Db, openingId: string) {
  const [o] = await db.select().from(opening).where(eq(opening.id, openingId));
  if (!o) throw new ConfigError("not_found", "No such opening");
  if (o.status === "closed") throw new ConfigError("opening_closed", "That opening is closed. Pick an open or draft opening.");
  return o;
}

export type CreateSessionInput = {
  actor: Actor;
  openingId: string;
  startsAt: Date;
  locationName: string;
  locationAddress?: string | null;
  invitedCount?: number | null;
  attendedCount?: number | null;
  notes?: string | null;
};

// Creating a session also creates its entry code (channel session_qr), so the QR
// can be downloaded at once.
export async function createSession(
  db: Db,
  input: CreateSessionInput,
): Promise<{ id: string; entryCodeId: string; code: string }> {
  if (input.actor.type !== "staff") throw new ConfigError("invalid_input", "Sessions are created by signed-in staff");
  const fields = cleanFields({
    openingId: input.openingId,
    startsAt: input.startsAt,
    locationName: input.locationName,
    locationAddress: input.locationAddress ?? null,
    invitedCount: input.invitedCount ?? null,
    attendedCount: input.attendedCount ?? null,
    notes: input.notes ?? null,
    status: "scheduled",
  });
  const actorUserId = input.actor.userId;

  return db.transaction(async (tx) => {
    const o = await loadOpenOrDraftOpening(tx, fields.openingId);
    const id = uuidv7();
    await tx.insert(groupSession).values({ id, ...fields, createdBy: actorUserId });
    const code = await createEntryCode(tx, {
      actor: input.actor,
      label: sessionCodeLabel(fields.startsAt, fields.locationName),
      channel: "session_qr",
      roleId: o.roleId,
      openingId: o.id,
      groupSessionId: id,
    });
    await writeAudit(tx, {
      actor: input.actor,
      action: "group_session.create",
      entityType: "group_session",
      entityId: id,
      changes: {
        openingId: { from: null, to: o.id },
        startsAt: { from: null, to: fields.startsAt },
        locationName: { from: null, to: fields.locationName },
        invitedCount: { from: null, to: fields.invitedCount },
        entryCodeId: { from: null, to: code.id },
      },
    });
    return { id, entryCodeId: code.id, code: code.code };
  });
}

export type SessionPatch = Partial<SessionFields>;

const AUDITED = [
  "openingId",
  "startsAt",
  "locationName",
  "locationAddress",
  "invitedCount",
  "attendedCount",
  "status",
  "notes",
] as const;

// The opening can change only while no application is attributed to the session,
// because an attributed application must belong to the session's opening.
export async function updateSession(db: Db, input: { actor: Actor; id: string; patch: SessionPatch }): Promise<SessionRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(groupSession)
      .where(and(eq(groupSession.id, input.id), isNull(groupSession.deletedAt)))
      .for("update");
    if (!before) throw new ConfigError("not_found", "No such session");

    const p = input.patch;
    const fields = cleanFields({
      openingId: p.openingId ?? before.openingId,
      startsAt: p.startsAt ?? before.startsAt,
      locationName: p.locationName ?? before.locationName,
      locationAddress: p.locationAddress === undefined ? before.locationAddress : p.locationAddress,
      invitedCount: p.invitedCount === undefined ? before.invitedCount : p.invitedCount,
      attendedCount: p.attendedCount === undefined ? before.attendedCount : p.attendedCount,
      notes: p.notes === undefined ? before.notes : p.notes,
      status: p.status ?? before.status,
    });

    if (fields.openingId !== before.openingId) {
      const [attributed] = await tx
        .select({ id: application.id })
        .from(application)
        .where(
          and(
            or(eq(application.attributedSessionId, before.id), eq(application.scannedSessionId, before.id)),
            isNull(application.deletedAt),
          ),
        )
        .limit(1);
      if (attributed) {
        throw new ConfigError("session_has_applicants", "Applicants are already attributed to this session, so its opening cannot change.");
      }
      const o = await loadOpenOrDraftOpening(tx, fields.openingId);
      await tx.update(entryCode).set({ roleId: o.roleId, openingId: o.id }).where(eq(entryCode.groupSessionId, before.id));
    }

    const [after] = await tx.update(groupSession).set(fields).where(eq(groupSession.id, before.id)).returning();
    if (fields.startsAt.getTime() !== before.startsAt.getTime() || fields.locationName !== before.locationName) {
      await tx
        .update(entryCode)
        .set({ label: sessionCodeLabel(fields.startsAt, fields.locationName) })
        .where(and(eq(entryCode.groupSessionId, before.id), eq(entryCode.channel, "session_qr")));
    }

    const changes = diffChanges(before, after!, AUDITED, ["notes"]);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "group_session.update",
        entityType: "group_session",
        entityId: before.id,
        changes,
      });
    }
    return after!;
  });
}

// Openings a session can be created for: anything not closed, newest first.
export async function listSessionOpenings(db: Db) {
  return db
    .select({ id: opening.id, name: opening.name, status: opening.status, roleName: role.internalName })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .where(inArray(opening.status, ["open", "draft"]))
    .orderBy(asc(role.sortOrder), desc(opening.opensOn));
}
