import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  application,
  appUser,
  INTERVIEW_BOOKED_VIA,
  INTERVIEW_GRADES,
  INTERVIEW_KINDS,
  INTERVIEW_RECOMMENDATIONS,
  interview,
  interviewGrade,
  type InterviewBookedVia,
  type InterviewGrade,
  type InterviewKind,
  type InterviewRecommendation,
  type InterviewStatus,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "../actor";
import { diffChanges, writeAudit } from "../audit";
import { centralInstant } from "../time";
import { INTERVIEW_CATEGORY_KEYS } from "./categories";

// One-on-ones and phone screens on the profile (DATA_MODEL.md, interview and
// interview_grade): schedule, reschedule, cancel, and record the result, held or a
// no-show, with a grade per scorecard category, an overall grade, a recommendation,
// notes and a Notion link. Hiring Managers and Admins write; Viewers read. Every write
// is audited, the notes and the Notion link as "[changed]". Nothing here moves or
// closes an application: after a no-show the profile points staff at the Close button.

export type InterviewErrorCode =
  | "application_not_found"
  | "application_closed"
  | "interview_not_found"
  | "not_allowed"
  | "invalid_kind"
  | "invalid_time"
  | "invalid_booked_via"
  | "interviewer_not_found"
  | "not_scheduled"
  | "interview_canceled"
  | "invalid_outcome"
  | "held_in_future"
  | "invalid_grade"
  | "unknown_category"
  | "invalid_recommendation"
  | "notes_too_long"
  | "invalid_notion_url";

export class InterviewError extends Error {
  constructor(
    readonly code: InterviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InterviewError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InterviewRow = typeof interview.$inferSelect;

export const INTERVIEW_NOTES_MAX_LENGTH = 4000;
const NOTION_URL_MAX_LENGTH = 2000;

// Staff may enter a time this far ahead of the server clock (browser skew), as with stage moves.
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const SCHEDULE_FIELDS = ["kind", "scheduledAt", "bookedVia", "interviewerUserId"] as const;
const RESULT_FIELDS = ["status", "heldAt", "overallGrade", "recommendation", "notes", "notionUrl"] as const;
const PII_FIELDS = ["notes", "notionUrl"] as const;

function requireWriter(role: UserRole) {
  if (role !== "admin" && role !== "hiring_manager") {
    throw new InterviewError("not_allowed", "Only Admins and Hiring Managers can change interviews");
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRealDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// The form's Central wall-clock date and time ("2026-11-02", "14:30") as an instant,
// through the one Central-time helper, so the browser's zone never matters and a day
// after the Nov 1 change gets standard time.
export function centralDateTime(date: string, time: string): Date {
  const d = date.trim();
  const match = TIME.exec(time.trim());
  if (!DATE.test(d) || !isRealDate(d) || !match) throw new InterviewError("invalid_time", "Enter the date and the time");
  return centralInstant(d, Number(match[1]), Number(match[2]));
}

function cleanInstant(value: Date | null | undefined, message: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new InterviewError("invalid_time", message);
  return value;
}

function cleanKind(kind: string): InterviewKind {
  if (!(INTERVIEW_KINDS as readonly string[]).includes(kind)) throw new InterviewError("invalid_kind", "Pick one-on-one or phone screen");
  return kind as InterviewKind;
}

function cleanBookedVia(value: string | null | undefined): InterviewBookedVia | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(INTERVIEW_BOOKED_VIA as readonly string[]).includes(value)) {
    throw new InterviewError("invalid_booked_via", "Pick booking link, phone or in person");
  }
  return value as InterviewBookedVia;
}

function cleanGrade(value: string | null | undefined): InterviewGrade | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(INTERVIEW_GRADES as readonly string[]).includes(value)) throw new InterviewError("invalid_grade", "Pick a grade from A+ to F");
  return value as InterviewGrade;
}

function cleanRecommendation(value: string | null | undefined): InterviewRecommendation | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(INTERVIEW_RECOMMENDATIONS as readonly string[]).includes(value)) {
    throw new InterviewError("invalid_recommendation", "Pick hire, maybe or no hire");
  }
  return value as InterviewRecommendation;
}

function cleanNotes(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (trimmed.length > INTERVIEW_NOTES_MAX_LENGTH) {
    throw new InterviewError("notes_too_long", `Keep the notes under ${INTERVIEW_NOTES_MAX_LENGTH} characters`);
  }
  return trimmed;
}

// A link to the interview's Notion page: https on notion.so or notion.site (or one of
// their subdomains) only, with no user name, password or port in it.
export function cleanNotionUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const invalid = new InterviewError("invalid_notion_url", "Paste a Notion link: it starts with https:// and is on notion.so or notion.site");
  if (trimmed.length > NOTION_URL_MAX_LENGTH) throw invalid;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid;
  }
  const host = url.hostname.toLowerCase();
  const notion = ["notion.so", "notion.site"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (url.protocol !== "https:" || !notion || url.username || url.password || url.port) throw invalid;
  return url.toString();
}

// The grades for the current scorecard: a known category key to a grade, or null
// for "not graded". Categories left out are not graded.
function cleanGrades(grades: Readonly<Record<string, string | null | undefined>>): Record<string, InterviewGrade> {
  const out: Record<string, InterviewGrade> = {};
  for (const [key, value] of Object.entries(grades)) {
    if (!INTERVIEW_CATEGORY_KEYS.includes(key)) throw new InterviewError("unknown_category", `"${key}" is not on the interview scorecard`);
    const grade = cleanGrade(value);
    if (grade) out[key] = grade;
  }
  return out;
}

function sameGrades(a: Record<string, InterviewGrade>, b: Record<string, InterviewGrade>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

async function loadApplication(tx: Tx, applicationId: string) {
  const [row] = await tx
    .select({ id: application.id, personId: application.personId, status: application.status, deletedAt: application.deletedAt })
    .from(application)
    .where(eq(application.id, applicationId));
  if (!row || row.deletedAt) throw new InterviewError("application_not_found", "No such application");
  return row;
}

async function lockInterview(tx: Tx, interviewId: string) {
  const [row] = await tx.select().from(interview).where(eq(interview.id, interviewId)).for("update");
  if (!row || row.deletedAt) throw new InterviewError("interview_not_found", "No such interview");
  const app = await loadApplication(tx, row.applicationId);
  return { before: row, app };
}

// The interviewer is any active staff account; a disabled one can no longer be picked.
async function checkInterviewer(tx: Tx, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [row] = await tx.select({ id: appUser.id, status: appUser.status }).from(appUser).where(eq(appUser.id, userId));
  if (!row || row.status !== "active") throw new InterviewError("interviewer_not_found", "Pick the interviewer from the staff list");
  return row.id;
}

export type ScheduleInterviewInput = {
  applicationId: string;
  userId: string;
  // Checked here as well as in the action: Viewers only read interviews.
  role: UserRole;
  kind: InterviewKind;
  scheduledAt: Date;
  bookedVia?: InterviewBookedVia | null;
  interviewerUserId?: string | null;
  now?: Date;
};

// A closed application is reopened before anything is scheduled for it.
export async function scheduleInterview(db: Db, input: ScheduleInterviewInput): Promise<{ interviewId: string }> {
  requireWriter(input.role);
  const kind = cleanKind(input.kind);
  const scheduledAt = cleanInstant(input.scheduledAt, "Enter the date and the time");
  const bookedVia = cleanBookedVia(input.bookedVia);
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const app = await loadApplication(tx, input.applicationId);
    if (app.status === "closed") {
      throw new InterviewError("application_closed", "This application is closed. Reopen it before scheduling an interview.");
    }
    const interviewerUserId = await checkInterviewer(tx, input.interviewerUserId);
    const id = uuidv7();
    await tx.insert(interview).values({
      id,
      applicationId: app.id,
      kind,
      status: "scheduled",
      scheduledAt,
      bookedVia,
      interviewerUserId,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "interview.schedule",
      entityType: "interview",
      entityId: id,
      personId: app.personId,
      applicationId: app.id,
      changes: {
        kind: { from: null, to: kind },
        status: { from: null, to: "scheduled" },
        scheduledAt: { from: null, to: scheduledAt },
        bookedVia: { from: null, to: bookedVia },
        interviewerUserId: { from: null, to: interviewerUserId },
      },
      occurredAt: now,
    });
    return { interviewId: id };
  });
}

export type RescheduleInterviewInput = {
  interviewId: string;
  userId: string;
  role: UserRole;
  kind?: InterviewKind;
  scheduledAt: Date;
  bookedVia?: InterviewBookedVia | null;
  interviewerUserId?: string | null;
  now?: Date;
};

// A new time, way of booking or interviewer for an interview still to come. A held
// interview or a no-show is a fact, so another try is a new interview.
export async function rescheduleInterview(db: Db, input: RescheduleInterviewInput): Promise<{ changed: boolean }> {
  requireWriter(input.role);
  const scheduledAt = cleanInstant(input.scheduledAt, "Enter the date and the time");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const { before, app } = await lockInterview(tx, input.interviewId);
    if (before.status !== "scheduled") throw new InterviewError("not_scheduled", "Only an interview still to come can be rescheduled. Schedule a new one instead.");
    if (app.status === "closed") {
      throw new InterviewError("application_closed", "This application is closed. Reopen it before rescheduling, or cancel the interview.");
    }
    const after: InterviewRow = {
      ...before,
      kind: input.kind === undefined ? before.kind : cleanKind(input.kind),
      scheduledAt,
      bookedVia: input.bookedVia === undefined ? before.bookedVia : cleanBookedVia(input.bookedVia),
      interviewerUserId:
        input.interviewerUserId === undefined || (input.interviewerUserId ?? null) === before.interviewerUserId
          ? before.interviewerUserId
          : await checkInterviewer(tx, input.interviewerUserId),
    };
    const changes = diffChanges(before, after, SCHEDULE_FIELDS);
    if (Object.keys(changes).length === 0) return { changed: false };
    await tx
      .update(interview)
      .set({ kind: after.kind, scheduledAt: after.scheduledAt, bookedVia: after.bookedVia, interviewerUserId: after.interviewerUserId, updatedAt: now })
      .where(eq(interview.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "interview.reschedule",
      entityType: "interview",
      entityId: before.id,
      personId: app.personId,
      applicationId: app.id,
      changes,
      occurredAt: now,
    });
    return { changed: true };
  });
}

export async function cancelInterview(db: Db, input: { interviewId: string; userId: string; role: UserRole; now?: Date }): Promise<void> {
  requireWriter(input.role);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const { before, app } = await lockInterview(tx, input.interviewId);
    if (before.status !== "scheduled") throw new InterviewError("not_scheduled", "Only an interview still to come can be canceled");
    await tx.update(interview).set({ status: "canceled", updatedAt: now }).where(eq(interview.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "interview.cancel",
      entityType: "interview",
      entityId: before.id,
      personId: app.personId,
      applicationId: app.id,
      changes: { status: { from: before.status, to: "canceled" } },
      occurredAt: now,
    });
  });
}

export type InterviewResultInput = {
  interviewId: string;
  userId: string;
  role: UserRole;
  outcome: "held" | "no_show";
  // Required when held.
  heldAt?: Date | null;
  // The current scorecard: category key to a grade, or null for not graded. Held only.
  grades?: Readonly<Record<string, InterviewGrade | null | undefined>>;
  overallGrade?: InterviewGrade | null;
  recommendation?: InterviewRecommendation | null;
  // No medical observations.
  notes?: string | null;
  notionUrl?: string | null;
  now?: Date;
};

// Records how an interview went, and corrects it later the same way. A no-show has no
// held time, grades or recommendation; switching a held interview to a no-show clears
// them. Grades under a category no longer on the scorecard are left as they are.
export async function recordInterviewResult(db: Db, input: InterviewResultInput): Promise<{ changed: boolean }> {
  requireWriter(input.role);
  if (input.outcome !== "held" && input.outcome !== "no_show") throw new InterviewError("invalid_outcome", "Pick held or no-show");
  const now = input.now ?? new Date();
  const held = input.outcome === "held";
  let heldAt: Date | null = null;
  if (held) {
    heldAt = cleanInstant(input.heldAt, "Enter when the interview was held");
    if (heldAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw new InterviewError("held_in_future", "The time it was held cannot be in the future");
    }
  }
  const grades = held ? cleanGrades(input.grades ?? {}) : {};
  const overallGrade = held ? cleanGrade(input.overallGrade) : null;
  const recommendation = held ? cleanRecommendation(input.recommendation) : null;
  const notes = cleanNotes(input.notes);
  const notionUrl = cleanNotionUrl(input.notionUrl);

  return db.transaction(async (tx) => {
    const { before, app } = await lockInterview(tx, input.interviewId);
    if (before.status === "canceled") throw new InterviewError("interview_canceled", "This interview was canceled. Schedule a new one instead.");
    const stored = await tx.select().from(interviewGrade).where(eq(interviewGrade.interviewId, before.id));
    const beforeGrades = Object.fromEntries(
      stored.filter((row) => INTERVIEW_CATEGORY_KEYS.includes(row.categoryKey)).map((row) => [row.categoryKey, row.grade]),
    ) as Record<string, InterviewGrade>;

    const status: InterviewStatus = input.outcome;
    const after: InterviewRow = { ...before, status, heldAt, overallGrade, recommendation, notes, notionUrl };
    const changes = diffChanges(before, after, RESULT_FIELDS, PII_FIELDS);
    const gradesChanged = !sameGrades(beforeGrades, grades);
    if (gradesChanged) changes.grades = { from: beforeGrades, to: grades };
    if (Object.keys(changes).length === 0) return { changed: false };

    await tx
      .update(interview)
      .set({ status, heldAt, overallGrade, recommendation, notes, notionUrl, updatedAt: now })
      .where(eq(interview.id, before.id));
    if (gradesChanged) {
      await tx
        .delete(interviewGrade)
        .where(and(eq(interviewGrade.interviewId, before.id), inArray(interviewGrade.categoryKey, [...INTERVIEW_CATEGORY_KEYS])));
      const rows = Object.entries(grades).map(([categoryKey, grade]) => ({ interviewId: before.id, categoryKey, grade }));
      if (rows.length > 0) await tx.insert(interviewGrade).values(rows);
    }
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "interview.result",
      entityType: "interview",
      entityId: before.id,
      personId: app.personId,
      applicationId: app.id,
      changes,
      occurredAt: now,
    });
    return { changed: true };
  });
}

// ---------------------------------------------------------------------------
// Reads

export type StaffChoice = { id: string; name: string | null; email: string };

export type InterviewView = {
  id: string;
  kind: InterviewKind;
  status: InterviewStatus;
  scheduledAt: Date | null;
  bookedVia: InterviewBookedVia | null;
  interviewer: StaffChoice | null;
  heldAt: Date | null;
  overallGrade: InterviewGrade | null;
  recommendation: InterviewRecommendation | null;
  notes: string | null;
  notionUrl: string | null;
  // Every stored grade, the current scorecard's and any from an older one.
  grades: Record<string, InterviewGrade>;
  createdAt: Date;
};

// An application's interviews, newest first.
export async function listInterviews(db: Db, applicationId: string): Promise<InterviewView[]> {
  const rows = await db
    .select({ row: interview, interviewerName: appUser.name, interviewerEmail: appUser.email })
    .from(interview)
    .leftJoin(appUser, eq(appUser.id, interview.interviewerUserId))
    .where(and(eq(interview.applicationId, applicationId), isNull(interview.deletedAt)))
    .orderBy(desc(interview.createdAt), desc(interview.id));
  if (rows.length === 0) return [];
  const gradeRows = await db
    .select()
    .from(interviewGrade)
    .where(
      inArray(
        interviewGrade.interviewId,
        rows.map((r) => r.row.id),
      ),
    );
  const gradesBy = new Map<string, Record<string, InterviewGrade>>();
  for (const g of gradeRows) gradesBy.set(g.interviewId, { ...gradesBy.get(g.interviewId), [g.categoryKey]: g.grade });
  return rows.map(({ row, interviewerName, interviewerEmail }) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    scheduledAt: row.scheduledAt,
    bookedVia: row.bookedVia,
    interviewer: row.interviewerUserId && interviewerEmail ? { id: row.interviewerUserId, name: interviewerName, email: interviewerEmail } : null,
    heldAt: row.heldAt,
    overallGrade: row.overallGrade,
    recommendation: row.recommendation,
    notes: row.notes,
    notionUrl: row.notionUrl,
    grades: gradesBy.get(row.id) ?? {},
    createdAt: row.createdAt,
  }));
}

// Who can be picked as the interviewer: every active staff account.
export async function listInterviewers(db: Db): Promise<StaffChoice[]> {
  return db
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.status, "active"))
    .orderBy(asc(appUser.name), asc(appUser.email));
}
