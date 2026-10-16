import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { application, attendee, auditLog, groupSession, person, type GroupInterviewArrival } from "@/db/schema";
import { staffActor, SYSTEM_ACTOR, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../config/errors";
import { assertCanAct, SessionError, type SessionStaff } from "./errors";
import { matchName, type NameMatch } from "./names";

// Matching group interview attendees to applications (DATA_MODEL.md, attendee and
// "Group interview attendance vs applications"). Most people at a session have no
// Tidepool application when they walk in: they apply later from the QR. So:
// - An exact mobile match links an attendee to the application its person has on the
//   session's opening (phone_match), whenever an attendee is added or edited, at the
//   door check-in, when the application is created, and for unmatched rows each time
//   the session page loads. Never across openings, at most one row per application
//   per session.
// - A name match is only a suggestion a staff member confirms (staff_confirmed) or
//   dismisses. Staff can unmatch a row; neither an unmatched nor a dismissed pair is
//   offered or linked again. The attendee.unmatch and attendee.suggestion_dismiss
//   audit rows are that record, since there is no table for it.
// - A link attributes an application with no group session to this one, and a door
//   check-in sets an arrival nobody recorded yet: on time when they checked in no
//   later than five minutes after the start, else late. Paper-sheet rows set no
//   arrival. Unmatching takes back what the link set, unless someone changed it since.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AttendeeRow = typeof attendee.$inferSelect;
type SessionRow = typeof groupSession.$inferSelect;
type ApplicationRow = typeof application.$inferSelect;

export type MatchMethod = "phone_match" | "staff_confirmed";

// A door check-in up to five minutes after the start counts as on time.
export const ON_TIME_GRACE_MS = 5 * 60_000;

export function arrivalForCheckIn(checkedInAt: Date, startsAt: Date): Extract<GroupInterviewArrival, "on_time" | "late"> {
  return checkedInAt.getTime() <= startsAt.getTime() + ON_TIME_GRACE_MS ? "on_time" : "late";
}

// The audit actions that record "this attendee is not that application".
const BLOCKING_ACTIONS = ["attendee.unmatch", "attendee.suggestion_dismiss"];

// True when staff unmatched or dismissed this attendee and application before.
function blockedPair(attendeeId: SQL, applicationId: SQL) {
  return sql`exists (
    select 1 from ${auditLog}
    where ${auditLog.entityType} = 'attendee' and ${auditLog.entityId} = ${attendeeId}
      and ${inArray(auditLog.action, BLOCKING_ACTIONS)} and ${auditLog.applicationId} = ${applicationId}
  )`;
}

async function lockAttendee(tx: Tx, attendeeId: string): Promise<AttendeeRow> {
  const [row] = await tx.select().from(attendee).where(eq(attendee.id, attendeeId)).for("update");
  if (!row || row.deletedAt) throw new SessionError("attendee_not_found", "That person is no longer on this session's list");
  return row;
}

async function loadSession(tx: Tx, sessionId: string): Promise<SessionRow> {
  const [row] = await tx.select().from(groupSession).where(eq(groupSession.id, sessionId));
  if (!row || row.deletedAt) throw new SessionError("session_not_found", "No such group session");
  return row;
}

type LinkInput = {
  attendee: AttendeeRow;
  session: SessionRow;
  applicationId: string;
  method: MatchMethod;
  actor: Actor;
  now: Date;
};

// Links a locked, unmatched attendee row to an application, then attributes the
// application to the session and records a door check-in's arrival when those are
// still blank. Runs inside the caller's transaction.
async function link(tx: Tx, input: LinkInput): Promise<void> {
  const { session, actor, now } = input;
  const row = input.attendee;
  if (session.status === "canceled") throw new SessionError("session_canceled", "This session was canceled");
  const [app] = await tx.select().from(application).where(eq(application.id, input.applicationId)).for("update");
  if (!app || app.deletedAt) throw new SessionError("application_not_found", "No such application");
  if (app.openingId !== session.openingId) {
    throw new SessionError("wrong_opening", "That applicant applied to a different opening than this session's");
  }
  const [taken] = await tx
    .select({ id: attendee.id })
    .from(attendee)
    .where(and(eq(attendee.groupSessionId, session.id), eq(attendee.applicationId, app.id)))
    .limit(1);
  if (taken) throw new SessionError("application_on_list", "That applicant is already matched to someone else on this list");

  await tx
    .update(attendee)
    .set({
      personId: app.personId,
      applicationId: app.id,
      matchMethod: input.method,
      matchedBy: actor.type === "staff" ? actor.userId : null,
      matchedAt: now,
      updatedAt: now,
    })
    .where(eq(attendee.id, row.id));
  await writeAudit(tx, {
    actor,
    action: "attendee.match",
    entityType: "attendee",
    entityId: row.id,
    personId: app.personId,
    applicationId: app.id,
    changes: {
      applicationId: { from: null, to: app.id },
      matchMethod: { from: row.matchMethod, to: input.method },
      groupSessionId: session.id,
    },
    occurredAt: now,
  });

  if (app.attributedSessionId === null) {
    await tx.update(application).set({ attributedSessionId: session.id, attributionMethod: input.method, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor,
      action: "application.session_attribution",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: {
        attributedSessionId: { from: null, to: session.id },
        attributionMethod: { from: app.attributionMethod, to: input.method },
        attendeeId: row.id,
      },
      occurredAt: now,
    });
  }

  if (row.source === "door_checkin" && app.groupInterviewArrival === null) {
    const arrival = arrivalForCheckIn(row.createdAt, session.startsAt);
    await tx.update(application).set({ groupInterviewArrival: arrival, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor,
      action: "application.arrival_change",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: {
        groupInterviewArrival: { from: null, to: arrival },
        groupSessionId: session.id,
        attendeeId: row.id,
        checkedInAt: row.createdAt,
      },
      occurredAt: now,
    });
  }
}

// The newest audit entry of one kind for an application: what set its current value.
async function latestChange(tx: Tx, applicationId: string, action: string): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ changes: auditLog.changes })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "application"), eq(auditLog.entityId, applicationId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(1);
  return row?.changes ?? null;
}

function fromValue(change: unknown): unknown {
  return change && typeof change === "object" && "from" in change ? (change as { from: unknown }).from : undefined;
}

// Clears a locked attendee row's match and takes back the session attribution and
// arrival its link set, when nothing has changed them since. The audit row it writes
// keeps the pair from being matched again.
async function unlink(tx: Tx, input: { attendee: AttendeeRow; session: SessionRow; actor: Actor; now: Date }): Promise<void> {
  const { session, actor, now } = input;
  const row = input.attendee;
  if (!row.applicationId) return;
  const [app] = await tx.select().from(application).where(eq(application.id, row.applicationId)).for("update");

  await tx
    .update(attendee)
    .set({ personId: null, applicationId: null, matchMethod: "none", matchedBy: null, matchedAt: null, updatedAt: now })
    .where(eq(attendee.id, row.id));
  await writeAudit(tx, {
    actor,
    action: "attendee.unmatch",
    entityType: "attendee",
    entityId: row.id,
    personId: row.personId,
    applicationId: row.applicationId,
    changes: {
      applicationId: { from: row.applicationId, to: null },
      matchMethod: { from: row.matchMethod, to: "none" },
      groupSessionId: session.id,
    },
    occurredAt: now,
  });
  if (!app) return;

  const attribution = await latestChange(tx, app.id, "application.session_attribution");
  if (attribution?.attendeeId === row.id && app.attributedSessionId === session.id) {
    const previousSession = fromValue(attribution.attributedSessionId);
    const previousMethod = fromValue(attribution.attributionMethod);
    const restored = {
      attributedSessionId: typeof previousSession === "string" ? previousSession : null,
      attributionMethod: (typeof previousMethod === "string" ? previousMethod : "none") as ApplicationRow["attributionMethod"],
    };
    await tx.update(application).set({ ...restored, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor,
      action: "application.session_attribution",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: {
        attributedSessionId: { from: app.attributedSessionId, to: restored.attributedSessionId },
        attributionMethod: { from: app.attributionMethod, to: restored.attributionMethod },
        unmatchedAttendeeId: row.id,
      },
      occurredAt: now,
    });
  }

  const arrival = await latestChange(tx, app.id, "application.arrival_change");
  if (arrival?.attendeeId === row.id && app.groupInterviewArrival !== null) {
    await tx.update(application).set({ groupInterviewArrival: null, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor,
      action: "application.arrival_change",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: { groupInterviewArrival: { from: app.groupInterviewArrival, to: null }, groupSessionId: session.id, unmatchedAttendeeId: row.id },
      occurredAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Exact mobile matches

// Unmatched attendees whose mobile belongs to exactly one person (not a shared
// number) with a live application on the session's opening, never a pair staff
// unmatched or dismissed, oldest row first.
async function phoneCandidates(db: Db, where: SQL): Promise<Candidate[]> {
  return db
    .select({ attendeeId: attendee.id, sessionId: attendee.groupSessionId, applicationId: application.id })
    .from(attendee)
    .innerJoin(groupSession, eq(groupSession.id, attendee.groupSessionId))
    .innerJoin(
      person,
      and(eq(person.mobileE164, attendee.mobileE164), isNull(person.deletedAt), eq(person.sharedMobile, false), isNull(person.mergedIntoPersonId)),
    )
    .innerJoin(application, and(eq(application.personId, person.id), eq(application.openingId, groupSession.openingId), isNull(application.deletedAt)))
    .where(
      and(
        where,
        isNull(attendee.deletedAt),
        isNull(attendee.applicationId),
        isNull(attendee.redactedAt),
        isNull(groupSession.deletedAt),
        ne(groupSession.status, "canceled"),
        sql`not ${blockedPair(sql`${attendee.id}`, sql`${application.id}`)}`,
      ),
    )
    .orderBy(asc(attendee.createdAt), asc(attendee.id));
}

type Candidate = { attendeeId: string; sessionId: string; applicationId: string };

// Links each candidate in its own transaction (a savepoint when the caller already
// holds one), so a row someone else matched a moment earlier is skipped, not fatal.
async function linkCandidates(db: Db, candidates: Candidate[], now: Date): Promise<Candidate[]> {
  const linked: Candidate[] = [];
  const used = new Set<string>();
  for (const candidate of candidates) {
    // Two rows with one mobile on one session would both point at the same application.
    const key = `${candidate.sessionId}:${candidate.applicationId}`;
    if (used.has(key)) continue;
    try {
      await db.transaction(async (tx) => {
        const row = await lockAttendee(tx, candidate.attendeeId);
        if (row.applicationId) return;
        const session = await loadSession(tx, row.groupSessionId);
        await link(tx, { attendee: row, session, applicationId: candidate.applicationId, method: "phone_match", actor: SYSTEM_ACTOR, now });
        linked.push(candidate);
        used.add(key);
      });
    } catch (error) {
      const skippable =
        (error instanceof SessionError && ["application_on_list", "attendee_not_found", "session_canceled"].includes(error.code)) ||
        pgErrorCode(error) === PG_UNIQUE_VIOLATION;
      if (!skippable) throw error;
    }
  }
  return linked;
}

// Every unmatched row of one session with an exact mobile match: run when the session
// page or its floor view loads, and from the Match now button.
export async function matchSessionByPhone(db: Db, sessionId: string, now: Date = new Date()): Promise<{ linked: number }> {
  const candidates = await phoneCandidates(db, eq(attendee.groupSessionId, sessionId));
  return { linked: (await linkCandidates(db, candidates, now)).length };
}

// One attendee row, right after it was added, edited or checked in at the door.
// Returns the application it was linked to, if any.
export async function matchAttendeeByPhone(db: Db, attendeeId: string, now: Date = new Date()): Promise<string | null> {
  const linked = await linkCandidates(db, await phoneCandidates(db, eq(attendee.id, attendeeId)), now);
  return linked[0]?.applicationId ?? null;
}

// Door check-ins and sheet rows on any session of the application's opening that carry
// its person's mobile: run when an application is created and when its profile loads.
export async function matchApplicationByPhone(db: Db, applicationId: string, now: Date = new Date()): Promise<{ linked: number }> {
  const candidates = await phoneCandidates(db, eq(application.id, applicationId));
  return { linked: (await linkCandidates(db, candidates, now)).length };
}

// ---------------------------------------------------------------------------
// Staff decisions

export type ConfirmMatchInput = { attendeeId: string; applicationId: string; staff: SessionStaff; now?: Date };

// A staff member says this attendee is that applicant: a suggested name match, or a
// pick from the opening's applicants for a nickname or a misspelling.
export async function confirmMatch(db: Db, input: ConfirmMatchInput): Promise<{ changed: boolean }> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockAttendee(tx, input.attendeeId);
    if (row.applicationId === input.applicationId) return { changed: false };
    if (row.applicationId) throw new SessionError("already_matched", "This person is already matched to an application. Unmatch them first.");
    const session = await loadSession(tx, row.groupSessionId);
    await link(tx, { attendee: row, session, applicationId: input.applicationId, method: "staff_confirmed", actor: staffActor(input.staff.userId), now });
    return { changed: true };
  });
}

export type DismissSuggestionInput = { attendeeId: string; applicationId: string; staff: SessionStaff; now?: Date };

// "Not them": the name match is not offered again for this attendee.
export async function dismissSuggestion(db: Db, input: DismissSuggestionInput): Promise<void> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  const [row] = await db.select().from(attendee).where(eq(attendee.id, input.attendeeId));
  if (!row || row.deletedAt) throw new SessionError("attendee_not_found", "That person is no longer on this session's list");
  const [app] = await db.select({ id: application.id, personId: application.personId }).from(application).where(eq(application.id, input.applicationId));
  if (!app) throw new SessionError("application_not_found", "No such application");
  await writeAudit(db, {
    actor: staffActor(input.staff.userId),
    action: "attendee.suggestion_dismiss",
    entityType: "attendee",
    entityId: row.id,
    personId: app.personId,
    applicationId: app.id,
    changes: { dismissedApplicationId: app.id, groupSessionId: row.groupSessionId },
    occurredAt: now,
  });
}

export type UnmatchInput = { attendeeId: string; staff: SessionStaff; now?: Date };

export async function unmatchAttendee(db: Db, input: UnmatchInput): Promise<void> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const row = await lockAttendee(tx, input.attendeeId);
    if (!row.applicationId) throw new SessionError("not_matched", "This person is not matched to an application");
    const session = await loadSession(tx, row.groupSessionId);
    await unlink(tx, { attendee: row, session, actor: staffActor(input.staff.userId), now });
  });
}

// For the attendee services: drops a match inside their own transaction, as the
// staff member whose edit or removal made it wrong.
export async function unlinkAttendee(tx: Tx, input: { attendee: AttendeeRow; staff: SessionStaff; now: Date }): Promise<void> {
  const session = await loadSession(tx, input.attendee.groupSessionId);
  await unlink(tx, { attendee: input.attendee, session, actor: staffActor(input.staff.userId), now: input.now });
}

// ---------------------------------------------------------------------------
// Name suggestions

export type SuggestionKind = NameMatch | "shared_phone";

export type MatchSuggestion = {
  attendeeId: string;
  applicationId: string;
  firstName: string | null;
  lastName: string | null;
  // The applicant's mobile on file, so staff can compare it with the sheet.
  mobile: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  kind: SuggestionKind;
};

export type SuggestionAttendee = { id: string; groupSessionId: string; nameAsWritten: string | null; mobileE164: string | null };

type Applicant = {
  applicationId: string;
  firstName: string | null;
  lastName: string | null;
  mobileE164: string | null;
  sharedMobile: boolean;
  startedAt: Date;
  submittedAt: Date | null;
};

const KIND_ORDER: Record<SuggestionKind, number> = { same_name: 0, shared_phone: 1, initial_and_last: 2 };
const MAX_SUGGESTIONS = 3;

// Live applications on an opening with their person's name and mobile.
export async function openingApplicants(db: Db, openingId: string, onlyApplicationId?: string): Promise<Applicant[]> {
  return db
    .select({
      applicationId: application.id,
      firstName: person.firstName,
      lastName: person.lastName,
      mobileE164: person.mobileE164,
      sharedMobile: person.sharedMobile,
      startedAt: application.startedAt,
      submittedAt: application.submittedAt,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .where(
      and(
        eq(application.openingId, openingId),
        isNull(application.deletedAt),
        isNull(person.deletedAt),
        onlyApplicationId ? eq(application.id, onlyApplicationId) : undefined,
      ),
    )
    .orderBy(asc(person.lastName), asc(person.firstName));
}

// Name suggestions (and people on a number marked shared) for unmatched attendees,
// best first, at most three each. Applications already matched on the attendee's
// session and pairs staff turned down are left out.
export async function suggestMatches(db: Db, attendees: SuggestionAttendee[], applicants: Applicant[]): Promise<Map<string, MatchSuggestion[]>> {
  const result = new Map<string, MatchSuggestion[]>();
  if (attendees.length === 0 || applicants.length === 0) return result;
  const sessionIds = [...new Set(attendees.map((a) => a.groupSessionId))];
  const [taken, blocked] = await Promise.all([
    db
      .select({ sessionId: attendee.groupSessionId, applicationId: attendee.applicationId })
      .from(attendee)
      .where(and(inArray(attendee.groupSessionId, sessionIds), sql`${attendee.applicationId} is not null`)),
    db
      .select({ attendeeId: auditLog.entityId, applicationId: auditLog.applicationId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "attendee"),
          inArray(
            auditLog.entityId,
            attendees.map((a) => a.id),
          ),
          inArray(auditLog.action, BLOCKING_ACTIONS),
        ),
      ),
  ]);
  const takenKeys = new Set(taken.map((t) => `${t.sessionId}:${t.applicationId}`));
  const blockedKeys = new Set(blocked.map((b) => `${b.attendeeId}:${b.applicationId}`));

  for (const row of attendees) {
    const found: MatchSuggestion[] = [];
    for (const applicant of applicants) {
      if (takenKeys.has(`${row.groupSessionId}:${applicant.applicationId}`) || blockedKeys.has(`${row.id}:${applicant.applicationId}`)) continue;
      const byName = row.nameAsWritten ? matchName(row.nameAsWritten, applicant.firstName, applicant.lastName) : null;
      const byPhone = applicant.sharedMobile && row.mobileE164 !== null && row.mobileE164 === applicant.mobileE164;
      const kind: SuggestionKind | null = byName === "same_name" ? byName : byPhone ? "shared_phone" : byName;
      if (!kind) continue;
      found.push({
        attendeeId: row.id,
        applicationId: applicant.applicationId,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        mobile: applicant.mobileE164,
        startedAt: applicant.startedAt,
        submittedAt: applicant.submittedAt,
        kind,
      });
    }
    found.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.startedAt.getTime() - a.startedAt.getTime());
    if (found.length > 0) result.set(row.id, found.slice(0, MAX_SUGGESTIONS));
  }
  return result;
}
