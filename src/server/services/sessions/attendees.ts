import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { attendee, groupSession, type AttendeeSource } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "../actor";
import { CHANGED, diffChanges, writeAudit } from "../audit";
import { normalizeUsMobile } from "../landing";
import { centralDate } from "../time";
import { assertCanAct, SessionError, type SessionStaff } from "./errors";
import { matchAttendeeByPhone, unlinkAttendee } from "./matching";

// Who came to a group interview (DATA_MODEL.md, attendee): rows typed in from the
// paper sign-up sheet, added by staff for someone not on it, or checked in by the
// person at the door on a tablet. One live row per mobile per session. A row with a
// mobile is matched by phone at once (matching.ts). Staff edits and removals are
// audited; a name or mobile is contact data, so the audit records "[changed]".

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SessionRow = typeof groupSession.$inferSelect;
type AttendeeRow = typeof attendee.$inferSelect;

export const ATTENDEE_NAME_MAX = 120;

// The sources staff pick when typing a row in; door_checkin comes from the kiosk only.
export const STAFF_SOURCES = ["paper_sheet", "staff_added"] as const satisfies readonly AttendeeSource[];
export type StaffSource = (typeof STAFF_SOURCES)[number];

function cleanName(name: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new SessionError("name_required", "Enter the name as it is written");
  if (cleaned.length > ATTENDEE_NAME_MAX) throw new SessionError("name_too_long", `Keep the name under ${ATTENDEE_NAME_MAX} characters`);
  return cleaned;
}

// A blank mobile is allowed on a sheet row; anything typed must be a US mobile.
function cleanMobile(mobile: string | null | undefined, required: boolean): string | null {
  const typed = mobile?.trim() ?? "";
  if (!typed) {
    if (required) throw new SessionError("invalid_mobile", "Enter your mobile number");
    return null;
  }
  const e164 = normalizeUsMobile(typed);
  if (!e164) throw new SessionError("invalid_mobile", required ? "Enter a 10-digit US mobile number" : "Enter a 10-digit US mobile number, or leave it blank");
  return e164;
}

async function lockSession(tx: Tx, sessionId: string): Promise<SessionRow> {
  const [row] = await tx.select().from(groupSession).where(eq(groupSession.id, sessionId)).for("update");
  if (!row || row.deletedAt) throw new SessionError("session_not_found", "No such group session");
  return row;
}

async function lockAttendee(tx: Tx, attendeeId: string): Promise<AttendeeRow> {
  const [row] = await tx.select().from(attendee).where(eq(attendee.id, attendeeId)).for("update");
  if (!row || row.deletedAt) throw new SessionError("attendee_not_found", "That person is no longer on this session's list");
  return row;
}

// The live row on this session with that mobile, other than `exceptId`.
async function rowWithMobile(tx: Tx, sessionId: string, mobile: string, exceptId?: string): Promise<AttendeeRow | null> {
  const [row] = await tx
    .select()
    .from(attendee)
    .where(
      and(
        eq(attendee.groupSessionId, sessionId),
        eq(attendee.mobileE164, mobile),
        isNull(attendee.deletedAt),
        exceptId ? ne(attendee.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

function onListError(row: AttendeeRow): SessionError {
  return new SessionError("mobile_on_list", `That mobile number is already on this list, as ${row.nameAsWritten ?? "someone else"}`);
}

export type AddAttendeeInput = {
  sessionId: string;
  staff: SessionStaff;
  nameAsWritten: string;
  mobile?: string | null;
  source: StaffSource;
  now?: Date;
};

export type AttendeeResult = { attendeeId: string; matchedApplicationId: string | null };

// Typing in the sign-up sheet, or adding someone who is not on it.
export async function addAttendee(db: Db, input: AddAttendeeInput): Promise<AttendeeResult> {
  assertCanAct(input.staff);
  if (!(STAFF_SOURCES as readonly string[]).includes(input.source)) throw new SessionError("invalid_source", "Pick the sign-up sheet or not on the sheet");
  const name = cleanName(input.nameAsWritten);
  const mobile = cleanMobile(input.mobile, false);
  const now = input.now ?? new Date();

  const attendeeId = await db.transaction(async (tx) => {
    const session = await lockSession(tx, input.sessionId);
    if (session.status === "canceled") throw new SessionError("session_canceled", "This session was canceled, so nobody can be added to it");
    if (mobile) {
      const existing = await rowWithMobile(tx, session.id, mobile);
      if (existing) throw onListError(existing);
    }
    const id = uuidv7();
    await tx.insert(attendee).values({
      id,
      groupSessionId: session.id,
      nameAsWritten: name,
      mobileE164: mobile,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(tx, {
      actor: staffActor(input.staff.userId),
      action: "attendee.add",
      entityType: "attendee",
      entityId: id,
      changes: {
        source: { from: null, to: input.source },
        nameAsWritten: { from: null, to: CHANGED },
        ...(mobile ? { mobileE164: { from: null, to: CHANGED } } : {}),
        groupSessionId: session.id,
      },
      occurredAt: now,
    });
    return id;
  });
  const matchedApplicationId = mobile ? await matchAttendeeByPhone(db, attendeeId, now) : null;
  return { attendeeId, matchedApplicationId };
}

export type UpdateAttendeeInput = {
  attendeeId: string;
  staff: SessionStaff;
  nameAsWritten?: string;
  // Undefined keeps the mobile; null or blank clears it.
  mobile?: string | null;
  // Only between the sheet and added by staff; a door check-in stays one.
  source?: StaffSource;
  now?: Date;
};

// Fixing a misread name or mobile. A phone match that no longer fits the mobile is
// dropped, and the row is matched again by its new mobile.
export async function updateAttendee(db: Db, input: UpdateAttendeeInput): Promise<AttendeeResult & { changed: string[] }> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  const result = await db.transaction(async (tx) => {
    const [found] = await tx.select({ sessionId: attendee.groupSessionId }).from(attendee).where(eq(attendee.id, input.attendeeId));
    if (!found) throw new SessionError("attendee_not_found", "That person is no longer on this session's list");
    // Session first, then the row: the same order as an add or a check-in.
    const session = await lockSession(tx, found.sessionId);
    const before = await lockAttendee(tx, input.attendeeId);
    const name = input.nameAsWritten === undefined ? before.nameAsWritten : cleanName(input.nameAsWritten);
    const mobile = input.mobile === undefined ? before.mobileE164 : cleanMobile(input.mobile, false);
    let source = before.source;
    if (input.source !== undefined && input.source !== before.source) {
      if (before.source === "door_checkin" || !(STAFF_SOURCES as readonly string[]).includes(input.source)) {
        throw new SessionError("invalid_source", "A door check-in stays a door check-in");
      }
      source = input.source;
    }
    if (mobile && mobile !== before.mobileE164) {
      const existing = await rowWithMobile(tx, session.id, mobile, before.id);
      if (existing) throw onListError(existing);
    }

    const after = { ...before, nameAsWritten: name, mobileE164: mobile, source };
    const changes = diffChanges(before, after, ["nameAsWritten", "mobileE164", "source"], ["nameAsWritten", "mobileE164"]);
    if (Object.keys(changes).length === 0) return { changed: [] as string[], mobile, rematch: false };

    if (before.applicationId && before.matchMethod === "phone_match" && mobile !== before.mobileE164) {
      await unlinkAttendee(tx, { attendee: before, staff: input.staff, now });
    }
    await tx.update(attendee).set({ nameAsWritten: name, mobileE164: mobile, source, updatedAt: now }).where(eq(attendee.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.staff.userId),
      action: "attendee.update",
      entityType: "attendee",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.applicationId,
      changes: { ...changes, groupSessionId: session.id },
      occurredAt: now,
    });
    return { changed: Object.keys(changes), mobile, rematch: mobile !== before.mobileE164 };
  });
  const matchedApplicationId = result.mobile && result.rematch ? await matchAttendeeByPhone(db, input.attendeeId, now) : null;
  return { attendeeId: input.attendeeId, changed: result.changed, matchedApplicationId };
}

export type RemoveAttendeeInput = { attendeeId: string; staff: SessionStaff; now?: Date };

// Soft delete: the row and its stars stay in the database but no longer show or
// count. A match is dropped first, so the application can be matched again.
export async function removeAttendee(db: Db, input: RemoveAttendeeInput): Promise<void> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const before = await lockAttendee(tx, input.attendeeId);
    if (before.applicationId) await unlinkAttendee(tx, { attendee: before, staff: input.staff, now });
    await tx.update(attendee).set({ deletedAt: now, updatedAt: now }).where(eq(attendee.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.staff.userId),
      action: "attendee.remove",
      entityType: "attendee",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.applicationId,
      changes: { deletedAt: { from: null, to: now }, groupSessionId: before.groupSessionId },
      occurredAt: now,
    });
  });
}

// ---------------------------------------------------------------------------
// The door check-in kiosk

export type CheckInState = { open: true } | { open: false; reason: "canceled" | "not_yet" | "over" };

// Check-in is open all day (Central) on the day of a scheduled or held session.
export function checkInState(session: Pick<SessionRow, "status" | "startsAt">, now: Date): CheckInState {
  if (session.status === "canceled") return { open: false, reason: "canceled" };
  const day = centralDate(session.startsAt);
  const today = centralDate(now);
  if (day === today) return { open: true };
  return { open: false, reason: day > today ? "not_yet" : "over" };
}

const CLOSED_MESSAGES: Record<Exclude<CheckInState, { open: true }>["reason"], string> = {
  canceled: "This group interview was canceled, so check-in is closed.",
  not_yet: "Check-in opens on the day of the group interview.",
  over: "This group interview is over, so check-in is closed.",
};

export function checkInClosedMessage(reason: Exclude<CheckInState, { open: true }>["reason"]): string {
  return CLOSED_MESSAGES[reason];
}

export type CheckInInput = {
  sessionId: string;
  // The staff member signed in on the tablet: only Admins and Hiring Managers open it.
  staff: SessionStaff;
  name: string;
  mobile: string;
  now?: Date;
};

export type CheckInResult = { attendeeId: string; firstName: string; repeat: boolean };

// One person at the door. The same mobile twice on one session updates the row it
// already has (the name, if they typed it differently), so the time of the first
// check-in stands. Nothing here records or implies consent to texts.
export async function checkIn(db: Db, input: CheckInInput): Promise<CheckInResult> {
  assertCanAct(input.staff);
  const name = cleanName(input.name);
  const mobile = cleanMobile(input.mobile, true)!;
  const now = input.now ?? new Date();

  const result = await db.transaction(async (tx) => {
    const session = await lockSession(tx, input.sessionId);
    const state = checkInState(session, now);
    if (!state.open) throw new SessionError("checkin_closed", checkInClosedMessage(state.reason));
    const existing = await rowWithMobile(tx, session.id, mobile);
    if (existing) {
      if (existing.nameAsWritten !== name) {
        await tx.update(attendee).set({ nameAsWritten: name, updatedAt: now }).where(eq(attendee.id, existing.id));
      }
      return { attendeeId: existing.id, repeat: true, matched: Boolean(existing.applicationId) };
    }
    const id = uuidv7();
    await tx.insert(attendee).values({
      id,
      groupSessionId: session.id,
      nameAsWritten: name,
      mobileE164: mobile,
      source: "door_checkin",
      createdAt: now,
      updatedAt: now,
    });
    return { attendeeId: id, repeat: false, matched: false };
  });
  if (!result.matched) await matchAttendeeByPhone(db, result.attendeeId, now);
  // For the thank-you: "Thanks, Jon."
  const firstName = name.split(" ")[0]!.replace(/[^\p{L}\p{N}'-]+$/u, "");
  return { attendeeId: result.attendeeId, firstName, repeat: result.repeat };
}
