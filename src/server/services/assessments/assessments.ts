import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import { application, appUser, ASSESSMENT_RESULTS, assessment, picklistOption, role, type AssessmentResult } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "../actor";
import { CHANGED, writeAudit } from "../audit";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../config/errors";
import { centralDate } from "../time";

// The ladder test and any later per-role test (DATA_MODEL.md, assessment). The tests a
// role uses come from the assessment_type picklist, so a new test needs no schema
// change. One live result per test per application, which the partial unique backs:
// a correction voids the result and records a new one. The note is Restricted: Admins
// and Hiring Managers see it, Viewers never do, and it is never a medical observation.
// A fail never closes anyone; the profile points staff at the Close button and the
// "Did not pass the ladder test" reason. Every write is audited, the note as "[changed]".

export type AssessmentErrorCode =
  | "application_not_found"
  | "not_allowed"
  | "type_not_found"
  | "type_wrong_role"
  | "type_archived"
  | "invalid_result"
  | "invalid_date"
  | "date_in_future"
  | "note_too_long"
  | "already_recorded"
  | "assessment_not_found"
  | "already_voided";

export class AssessmentError extends Error {
  constructor(
    readonly code: AssessmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssessmentError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const ASSESSMENT_NOTE_MAX_LENGTH = 2000;

function requireWriter(role: UserRole) {
  if (role !== "admin" && role !== "hiring_manager") {
    throw new AssessmentError("not_allowed", "Only Admins and Hiring Managers can record test results");
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(value: string, today: string): string {
  const date = value.trim();
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (!DATE.test(date) || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new AssessmentError("invalid_date", "Enter the date of the test");
  }
  if (date > today) throw new AssessmentError("date_in_future", "The test date cannot be in the future");
  return date;
}

export type AssessmentType = { id: string; key: string; label: string; archivedAt: Date | null };

// The tests a role uses: assessment_type options for the role, its employer or every
// employer, in list order. Archived ones only when asked, for results recorded earlier.
export async function listAssessmentTypes(db: Db, roleId: string, options: { includeArchived?: boolean } = {}): Promise<AssessmentType[]> {
  const [roleRow] = await db.select({ employerId: role.employerId }).from(role).where(eq(role.id, roleId));
  if (!roleRow) return [];
  return db
    .select({ id: picklistOption.id, key: picklistOption.key, label: picklistOption.label, archivedAt: picklistOption.archivedAt })
    .from(picklistOption)
    .where(
      and(
        eq(picklistOption.listKey, "assessment_type"),
        or(isNull(picklistOption.employerId), eq(picklistOption.employerId, roleRow.employerId)),
        or(isNull(picklistOption.roleId), eq(picklistOption.roleId, roleId)),
        options.includeArchived ? undefined : isNull(picklistOption.archivedAt),
      ),
    )
    .orderBy(asc(picklistOption.sortOrder), asc(picklistOption.label));
}

async function loadApplication(tx: Tx, applicationId: string) {
  const [row] = await tx
    .select({ id: application.id, personId: application.personId, roleId: application.roleId, deletedAt: application.deletedAt })
    .from(application)
    .where(eq(application.id, applicationId));
  if (!row || row.deletedAt) throw new AssessmentError("application_not_found", "No such application");
  return row;
}

export type RecordAssessmentInput = {
  applicationId: string;
  // The staff member recording it, who is the one who gave the test.
  userId: string;
  role: UserRole;
  assessmentTypeOptionId: string;
  result: AssessmentResult;
  // A Central calendar date; defaults to today on the form.
  administeredOn: string;
  // Restricted. Never medical observations.
  note?: string | null;
  now?: Date;
};

export async function recordAssessment(db: Db, input: RecordAssessmentInput): Promise<{ assessmentId: string }> {
  requireWriter(input.role);
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(input.result)) {
    throw new AssessmentError("invalid_result", "Pick pass, fail or did not attempt");
  }
  const now = input.now ?? new Date();
  const administeredOn = cleanDate(input.administeredOn, centralDate(now));
  const note = input.note?.trim() || null;
  if (note && note.length > ASSESSMENT_NOTE_MAX_LENGTH) {
    throw new AssessmentError("note_too_long", `Keep the note under ${ASSESSMENT_NOTE_MAX_LENGTH} characters`);
  }

  return db.transaction(async (tx) => {
    const app = await loadApplication(tx, input.applicationId);
    const [type] = await tx.select().from(picklistOption).where(eq(picklistOption.id, input.assessmentTypeOptionId));
    if (!type || type.listKey !== "assessment_type") throw new AssessmentError("type_not_found", "Pick the test");
    const [appRole] = await tx.select({ employerId: role.employerId }).from(role).where(eq(role.id, app.roleId));
    if ((type.roleId && type.roleId !== app.roleId) || (type.employerId && type.employerId !== appRole?.employerId)) {
      throw new AssessmentError("type_wrong_role", "This role does not use that test");
    }
    if (type.archivedAt) throw new AssessmentError("type_archived", "That test is archived in Settings, Picklists");

    const [live] = await tx
      .select({ id: assessment.id })
      .from(assessment)
      .where(and(eq(assessment.applicationId, app.id), eq(assessment.assessmentTypeOptionId, type.id), isNull(assessment.voidedAt)));
    const recorded = new AssessmentError("already_recorded", `A ${type.label.toLowerCase()} result is already recorded. Void it first to record a new one.`);
    if (live) throw recorded;

    const id = uuidv7();
    try {
      await tx.insert(assessment).values({
        id,
        applicationId: app.id,
        assessmentTypeOptionId: type.id,
        result: input.result,
        administeredBy: input.userId,
        administeredOn,
        note,
        createdAt: now,
      });
    } catch (error) {
      // Someone recorded the same test a moment earlier: the partial unique decides.
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw recorded;
      throw error;
    }
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "assessment.record",
      entityType: "assessment",
      entityId: id,
      personId: app.personId,
      applicationId: app.id,
      changes: {
        type: { from: null, to: type.key },
        result: { from: null, to: input.result },
        administeredOn: { from: null, to: administeredOn },
        note: note ? { from: null, to: CHANGED } : { from: null, to: null },
      },
      occurredAt: now,
    });
    return { assessmentId: id };
  });
}

// Marks a result as entered in error. It stays in the history, struck through, and the
// test can be recorded again.
export async function voidAssessment(db: Db, input: { assessmentId: string; userId: string; role: UserRole; now?: Date }): Promise<void> {
  requireWriter(input.role);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(assessment).where(eq(assessment.id, input.assessmentId)).for("update");
    if (!before) throw new AssessmentError("assessment_not_found", "No such test result");
    if (before.voidedAt) throw new AssessmentError("already_voided", "This result was already voided");
    const app = await loadApplication(tx, before.applicationId);
    await tx.update(assessment).set({ voidedAt: now }).where(eq(assessment.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "assessment.void",
      entityType: "assessment",
      entityId: before.id,
      personId: app.personId,
      applicationId: app.id,
      changes: { voidedAt: { from: null, to: now }, result: before.result },
      occurredAt: now,
    });
  });
}

export type AssessmentView = {
  id: string;
  assessmentTypeOptionId: string;
  result: AssessmentResult;
  administeredOn: string;
  administeredBy: { id: string; name: string | null; email: string };
  // Null for a Viewer, whatever was written.
  note: string | null;
  voidedAt: Date | null;
  createdAt: Date;
};

// An application's results, live and voided, newest first. Viewers never get the note.
export async function listAssessments(db: Db, applicationId: string, viewer: UserRole): Promise<AssessmentView[]> {
  const rows = await db
    .select({ row: assessment, byName: appUser.name, byEmail: appUser.email })
    .from(assessment)
    .innerJoin(appUser, eq(appUser.id, assessment.administeredBy))
    .where(eq(assessment.applicationId, applicationId))
    .orderBy(desc(assessment.createdAt), desc(assessment.id));
  const seesNote = viewer === "admin" || viewer === "hiring_manager";
  return rows.map(({ row, byName, byEmail }) => ({
    id: row.id,
    assessmentTypeOptionId: row.assessmentTypeOptionId,
    result: row.result,
    administeredOn: row.administeredOn,
    administeredBy: { id: row.administeredBy, name: byName, email: byEmail },
    note: seesNote ? row.note : null,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
  }));
}
