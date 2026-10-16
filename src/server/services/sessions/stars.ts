import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import { attendee, groupSession, opening, picklistOption, role, star, type StarMark } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "../actor";
import { CHANGED, writeAudit } from "../audit";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../config/errors";
import { assertCanAct, SessionError, type SessionStaff } from "./errors";

// Stars and concerns staff give attendees during a group interview (DATA_MODEL.md,
// star). Each staff member gives at most one live star and one live concern per
// attendee; taking one back soft-deletes it. A reason comes from the role's
// star_reason picklist: optional for a star, while a concern needs a reason or a
// note. Notes are at most 140 characters and are PII text, so the audit records
// "[changed]".

export const STAR_NOTE_MAX = 140;

export type StarReason = { id: string; key: string; label: string; requiresNote: boolean };

// The star reasons for the session's role: options for that role, its employer or
// everyone, not archived, in the picklist's order.
export async function listStarReasons(db: Db, sessionId: string): Promise<StarReason[]> {
  const [scope] = await db
    .select({ roleId: role.id, employerId: role.employerId })
    .from(groupSession)
    .innerJoin(opening, eq(opening.id, groupSession.openingId))
    .innerJoin(role, eq(role.id, opening.roleId))
    .where(eq(groupSession.id, sessionId));
  if (!scope) return [];
  return db
    .select({ id: picklistOption.id, key: picklistOption.key, label: picklistOption.label, requiresNote: picklistOption.requiresNote })
    .from(picklistOption)
    .where(
      and(
        eq(picklistOption.listKey, "star_reason"),
        isNull(picklistOption.archivedAt),
        or(isNull(picklistOption.employerId), eq(picklistOption.employerId, scope.employerId)),
        or(isNull(picklistOption.roleId), eq(picklistOption.roleId, scope.roleId)),
      ),
    )
    .orderBy(asc(picklistOption.sortOrder), asc(picklistOption.label));
}

function cleanNote(note: string | null | undefined): string | null {
  const cleaned = note?.trim() ?? "";
  if (!cleaned) return null;
  if (cleaned.length > STAR_NOTE_MAX) throw new SessionError("note_too_long", `Keep the note to ${STAR_NOTE_MAX} characters`);
  return cleaned;
}

export type AddMarkInput = {
  attendeeId: string;
  staff: SessionStaff;
  mark: StarMark;
  reasonOptionId?: string | null;
  note?: string | null;
  now?: Date;
};

// Gives a star or a concern. Giving one this staff member already gave changes
// nothing, so a double tap never doubles it or takes it back.
export async function addMark(db: Db, input: AddMarkInput): Promise<{ starId: string; added: boolean }> {
  assertCanAct(input.staff);
  const note = cleanNote(input.note);
  const reasonOptionId = input.reasonOptionId || null;
  if (input.mark === "concern" && !reasonOptionId && !note) {
    throw new SessionError("reason_required", "Pick a reason or write a note for a concern");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ attendee, sessionStatus: groupSession.status, sessionDeletedAt: groupSession.deletedAt })
      .from(attendee)
      .innerJoin(groupSession, eq(groupSession.id, attendee.groupSessionId))
      .where(eq(attendee.id, input.attendeeId));
    if (!row || row.attendee.deletedAt || row.sessionDeletedAt) {
      throw new SessionError("attendee_not_found", "That person is no longer on this session's list");
    }
    if (row.sessionStatus === "canceled") throw new SessionError("session_canceled", "This session was canceled");

    if (reasonOptionId) {
      const reasons = await listStarReasons(tx, row.attendee.groupSessionId);
      const reason = reasons.find((r) => r.id === reasonOptionId);
      if (!reason) throw new SessionError("invalid_reason", "Pick a reason from the list");
      if (reason.requiresNote && !note) throw new SessionError("note_required", `Add a note for "${reason.label}"`);
    }

    const existing = await liveMark(tx, input.attendeeId, input.staff.userId, input.mark);
    if (existing) return { starId: existing.id, added: false };

    const id = uuidv7();
    try {
      // A savepoint, so a double tap racing this insert leaves the transaction usable.
      await tx.transaction(async (sp) => {
        await sp.insert(star).values({ id, attendeeId: input.attendeeId, userId: input.staff.userId, mark: input.mark, reasonOptionId, note, createdAt: now });
      });
    } catch (error) {
      if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
      const raced = await liveMark(tx, input.attendeeId, input.staff.userId, input.mark);
      if (raced) return { starId: raced.id, added: false };
      throw error;
    }
    await writeAudit(tx, {
      actor: staffActor(input.staff.userId),
      action: "star.add",
      entityType: "star",
      entityId: id,
      personId: row.attendee.personId,
      applicationId: row.attendee.applicationId,
      changes: {
        mark: { from: null, to: input.mark },
        reasonOptionId: { from: null, to: reasonOptionId },
        ...(note ? { note: { from: null, to: CHANGED } } : {}),
        attendeeId: input.attendeeId,
        groupSessionId: row.attendee.groupSessionId,
      },
      occurredAt: now,
    });
    return { starId: id, added: true };
  });
}

async function liveMark(db: Db, attendeeId: string, userId: string, mark: StarMark) {
  const [row] = await db
    .select({ id: star.id })
    .from(star)
    .where(and(eq(star.attendeeId, attendeeId), eq(star.userId, userId), eq(star.mark, mark), isNull(star.deletedAt)));
  return row ?? null;
}

export type RemoveMarkInput = { attendeeId: string; staff: SessionStaff; mark: StarMark; now?: Date };

// Takes back this staff member's own star or concern (soft delete). Nothing to take
// back changes nothing.
export async function removeMark(db: Db, input: RemoveMarkInput): Promise<{ removed: boolean }> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(star)
      .where(and(eq(star.attendeeId, input.attendeeId), eq(star.userId, input.staff.userId), eq(star.mark, input.mark), isNull(star.deletedAt)))
      .for("update");
    if (!row) return { removed: false };
    const [owner] = await tx.select({ personId: attendee.personId, applicationId: attendee.applicationId, groupSessionId: attendee.groupSessionId }).from(attendee).where(eq(attendee.id, row.attendeeId));
    await tx.update(star).set({ deletedAt: now }).where(eq(star.id, row.id));
    await writeAudit(tx, {
      actor: staffActor(input.staff.userId),
      action: "star.remove",
      entityType: "star",
      entityId: row.id,
      personId: owner?.personId ?? null,
      applicationId: owner?.applicationId ?? null,
      changes: { deletedAt: { from: null, to: now }, mark: row.mark, attendeeId: row.attendeeId, groupSessionId: owner?.groupSessionId ?? null },
      occurredAt: now,
    });
    return { removed: true };
  });
}
