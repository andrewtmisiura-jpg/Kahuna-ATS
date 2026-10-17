import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import {
  application,
  appUser,
  attendee,
  groupSession,
  person,
  picklistOption,
  star,
  type AttendeeSource,
  type GroupInterviewArrival,
  type StarMark,
} from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import { openingApplicants, suggestMatches, type MatchSuggestion } from "./matching";

// Read side of the group session screens: the attendee list on the session page, the
// floor view's stars and concerns, and the attendance panel on an applicant's profile.

export type AttendeeMark = {
  id: string;
  mark: StarMark;
  userId: string;
  userName: string;
  reasonLabel: string | null;
  note: string | null;
  createdAt: Date;
};

export type AttendeeMatch = {
  applicationId: string;
  firstName: string | null;
  lastName: string | null;
  method: "none" | "scanned_session" | "phone_match" | "staff_confirmed";
  // Null for an automatic phone match.
  matchedByName: string | null;
  matchedAt: Date | null;
};

export type SessionAttendee = {
  id: string;
  nameAsWritten: string;
  mobile: string | null;
  source: AttendeeSource;
  // For a door check-in, when they checked in.
  createdAt: Date;
  match: AttendeeMatch | null;
  marks: AttendeeMark[];
  // Name matches waiting for a staff member, best first; empty once matched.
  suggestions: MatchSuggestion[];
};

// An applicant on the session's opening a staff member can match a row to by hand.
export type LinkChoice = { applicationId: string; firstName: string | null; lastName: string | null; mobile: string | null; startedAt: Date };

export type SessionAttendees = { attendees: SessionAttendee[]; choices: LinkChoice[] };

const matcher = alias(appUser, "matcher");

export type SessionSummary = { id: string; openingId: string; startsAt: Date; locationName: string; status: "scheduled" | "held" | "canceled" };

// The few facts the floor view and the door check-in show about a live session.
export async function getSessionSummary(db: Db, sessionId: string): Promise<SessionSummary | null> {
  const [row] = await db
    .select({
      id: groupSession.id,
      openingId: groupSession.openingId,
      startsAt: groupSession.startsAt,
      locationName: groupSession.locationName,
      status: groupSession.status,
    })
    .from(groupSession)
    .where(and(eq(groupSession.id, sessionId), isNull(groupSession.deletedAt)));
  return row ?? null;
}

// Marks on these attendees that are still live, oldest first, with who gave them.
async function loadMarks(db: Db, attendeeIds: string[]): Promise<Map<string, AttendeeMark[]>> {
  const result = new Map<string, AttendeeMark[]>();
  if (attendeeIds.length === 0) return result;
  const rows = await db
    .select({
      id: star.id,
      attendeeId: star.attendeeId,
      mark: star.mark,
      userId: star.userId,
      userName: sql<string>`coalesce(${appUser.name}, ${appUser.email})`,
      reasonLabel: picklistOption.label,
      note: star.note,
      createdAt: star.createdAt,
    })
    .from(star)
    .innerJoin(appUser, eq(appUser.id, star.userId))
    .leftJoin(picklistOption, eq(picklistOption.id, star.reasonOptionId))
    .where(and(inArray(star.attendeeId, attendeeIds), isNull(star.deletedAt)))
    .orderBy(asc(star.createdAt), asc(star.id));
  for (const { attendeeId, ...mark } of rows) {
    const list = result.get(attendeeId) ?? [];
    list.push(mark);
    result.set(attendeeId, list);
  }
  return result;
}

// The live attendee rows of a session, newest first, with their match, their marks
// and (when asked for) the name matches waiting for a staff member.
export async function loadSessionAttendees(db: Db, sessionId: string, options: { suggestions?: boolean } = {}): Promise<SessionAttendees> {
  const [session] = await db.select({ openingId: groupSession.openingId }).from(groupSession).where(eq(groupSession.id, sessionId));
  if (!session) return { attendees: [], choices: [] };
  const rows = await db
    .select({
      row: attendee,
      firstName: person.firstName,
      lastName: person.lastName,
      matchedByName: sql<string | null>`coalesce(${matcher.name}, ${matcher.email})`,
    })
    .from(attendee)
    .leftJoin(application, eq(application.id, attendee.applicationId))
    .leftJoin(person, eq(person.id, application.personId))
    .leftJoin(matcher, eq(matcher.id, attendee.matchedBy))
    .where(and(eq(attendee.groupSessionId, sessionId), isNull(attendee.deletedAt), isNull(attendee.redactedAt)))
    .orderBy(desc(attendee.createdAt), desc(attendee.id));

  const marks = await loadMarks(
    db,
    rows.map((r) => r.row.id),
  );
  let suggestions = new Map<string, MatchSuggestion[]>();
  let choices: LinkChoice[] = [];
  if (options.suggestions) {
    const applicants = await openingApplicants(db, session.openingId);
    const unmatched = rows.filter((r) => !r.row.applicationId).map((r) => r.row);
    suggestions = await suggestMatches(db, unmatched, applicants);
    const matched = new Set(rows.map((r) => r.row.applicationId).filter(Boolean));
    choices = applicants
      .filter((a) => !matched.has(a.applicationId))
      .map((a) => ({ applicationId: a.applicationId, firstName: a.firstName, lastName: a.lastName, mobile: a.mobileE164, startedAt: a.startedAt }));
  }

  return {
    attendees: rows.map(({ row, firstName, lastName, matchedByName }) => ({
      id: row.id,
      nameAsWritten: row.nameAsWritten ?? "",
      mobile: row.mobileE164,
      source: row.source,
      createdAt: row.createdAt,
      match: row.applicationId
        ? { applicationId: row.applicationId, firstName, lastName, method: row.matchMethod, matchedByName: row.matchedBy ? matchedByName : null, matchedAt: row.matchedAt }
        : null,
      marks: marks.get(row.id) ?? [],
      suggestions: suggestions.get(row.id) ?? [],
    })),
    choices,
  };
}

// Live attendee rows per session and how many are matched, for the session list.
export async function countAttendees(db: Db, sessionIds: string[]): Promise<Map<string, { attendees: number; matched: number }>> {
  const result = new Map<string, { attendees: number; matched: number }>();
  if (sessionIds.length === 0) return result;
  const rows = await db
    .select({
      sessionId: attendee.groupSessionId,
      attendees: sql<number>`count(*)::int`,
      matched: sql<number>`count(${attendee.applicationId})::int`,
    })
    .from(attendee)
    .where(and(inArray(attendee.groupSessionId, sessionIds), isNull(attendee.deletedAt)))
    .groupBy(attendee.groupSessionId);
  for (const row of rows) result.set(row.sessionId, { attendees: row.attendees, matched: row.matched });
  return result;
}

// ---------------------------------------------------------------------------
// The profile's attendance panel

export type AttendanceRow = {
  attendeeId: string;
  sessionId: string;
  startsAt: Date;
  locationName: string;
  sessionStatus: "scheduled" | "held" | "canceled";
  nameAsWritten: string;
  // Null for a Viewer, who sees no contact details.
  mobile: string | null;
  source: AttendeeSource;
  createdAt: Date;
  method: AttendeeMatch["method"];
  matchedByName: string | null;
  marks: AttendeeMark[];
};

export type AttendanceSuggestion = MatchSuggestion & {
  sessionId: string;
  startsAt: Date;
  locationName: string;
  nameAsWritten: string;
  source: AttendeeSource;
  createdAt: Date;
};

export type ApplicationAttendance = {
  arrival: GroupInterviewArrival | null;
  rows: AttendanceRow[];
  // Rows on the opening's sessions whose name matches this applicant. Staff only.
  suggestions: AttendanceSuggestion[];
};

// Every session this application is matched to through an attendee row, with the
// stars and concerns given there, and the unmatched rows that may be this person.
export async function loadApplicationAttendance(db: Db, applicationId: string, viewer: UserRole): Promise<ApplicationAttendance | null> {
  const [app] = await db
    .select({ id: application.id, openingId: application.openingId, arrival: application.groupInterviewArrival })
    .from(application)
    .where(and(eq(application.id, applicationId), isNull(application.deletedAt)));
  if (!app) return null;
  const staff = viewer !== "viewer";

  const rows = await db
    .select({
      row: attendee,
      startsAt: groupSession.startsAt,
      locationName: groupSession.locationName,
      sessionStatus: groupSession.status,
      matchedByName: sql<string | null>`coalesce(${matcher.name}, ${matcher.email})`,
    })
    .from(attendee)
    .innerJoin(groupSession, eq(groupSession.id, attendee.groupSessionId))
    .leftJoin(matcher, eq(matcher.id, attendee.matchedBy))
    .where(and(eq(attendee.applicationId, app.id), isNull(attendee.deletedAt), isNull(groupSession.deletedAt)))
    .orderBy(desc(groupSession.startsAt));
  const marks = await loadMarks(
    db,
    rows.map((r) => r.row.id),
  );

  let suggestions: AttendanceSuggestion[] = [];
  if (staff) {
    const linkedSessions = rows.map((r) => r.row.groupSessionId);
    const open = await db
      .select({ row: attendee, startsAt: groupSession.startsAt, locationName: groupSession.locationName })
      .from(attendee)
      .innerJoin(groupSession, eq(groupSession.id, attendee.groupSessionId))
      .where(
        and(
          eq(groupSession.openingId, app.openingId),
          isNull(groupSession.deletedAt),
          ne(groupSession.status, "canceled"),
          isNull(attendee.deletedAt),
          isNull(attendee.redactedAt),
          isNull(attendee.applicationId),
          linkedSessions.length > 0 ? notInArray(attendee.groupSessionId, linkedSessions) : undefined,
        ),
      )
      .orderBy(desc(groupSession.startsAt));
    if (open.length > 0) {
      const found = await suggestMatches(
        db,
        open.map((o) => o.row),
        await openingApplicants(db, app.openingId, app.id),
      );
      suggestions = open.flatMap(({ row, startsAt, locationName }) =>
        (found.get(row.id) ?? []).map((s) => ({
          ...s,
          sessionId: row.groupSessionId,
          startsAt,
          locationName,
          nameAsWritten: row.nameAsWritten ?? "",
          source: row.source,
          createdAt: row.createdAt,
        })),
      );
    }
  }

  return {
    arrival: app.arrival,
    rows: rows.map(({ row, startsAt, locationName, sessionStatus, matchedByName }) => ({
      attendeeId: row.id,
      sessionId: row.groupSessionId,
      startsAt,
      locationName,
      sessionStatus,
      nameAsWritten: row.nameAsWritten ?? "",
      mobile: staff ? row.mobileE164 : null,
      source: row.source,
      createdAt: row.createdAt,
      method: row.matchMethod,
      matchedByName: row.matchedBy ? matchedByName : null,
      marks: marks.get(row.id) ?? [],
    })),
    suggestions,
  };
}
