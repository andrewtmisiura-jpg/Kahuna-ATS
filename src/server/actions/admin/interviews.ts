"use server";

import { z } from "zod";
import { db } from "@/db";
import { ASSESSMENT_RESULTS, INTERVIEW_BOOKED_VIA, INTERVIEW_GRADES, INTERVIEW_KINDS, INTERVIEW_RECOMMENDATIONS } from "@/db/schema";
import { requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";
import { AssessmentError, recordAssessment, voidAssessment } from "@/server/services/assessments/assessments";
import {
  cancelInterview,
  centralDateTime,
  InterviewError,
  recordInterviewResult,
  rescheduleInterview,
  scheduleInterview,
} from "@/server/services/interviews/interviews";
import { toActionFailure, type ActionResult } from "./application-errors";

// The profile's interviews panel: one-on-ones and phone screens, and tests such as the
// ladder test. Each action starts with requireRole (Admins and Hiring Managers; Viewers
// only read), hands the work to a service and maps any error to an ActionResult; the
// client refreshes the page on success. Times arrive as Central wall-clock dates and
// times and become instants through the Central-time helper.

const ACTORS: readonly UserRole[] = ["admin", "hiring_manager"];

async function run<T>(fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(ACTORS);
    return { ok: true, data: await fn(user) };
  } catch (error) {
    if (error instanceof InterviewError || error instanceof AssessmentError) {
      return { ok: false, status: error.code.endsWith("_not_found") ? 404 : 400, code: error.code, message: error.message };
    }
    return toActionFailure(error);
  }
}

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const clock = z.string().regex(/^\d{2}:\d{2}$/, "Enter the time");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const grade = z.enum(INTERVIEW_GRADES).nullable();

const timeSchema = z.object({
  kind: z.enum(INTERVIEW_KINDS),
  // Central wall-clock date and time.
  date: isoDate,
  time: clock,
  bookedVia: z.enum(INTERVIEW_BOOKED_VIA).nullable(),
  interviewerUserId: uuid.nullable(),
});

const scheduleSchema = timeSchema.extend({ applicationId: uuid });

export async function scheduleInterviewAction(raw: z.input<typeof scheduleSchema>): Promise<ActionResult<{ interviewId: string }>> {
  return run(async (user) => {
    const input = scheduleSchema.parse(raw);
    return scheduleInterview(db, {
      applicationId: input.applicationId,
      userId: user.id,
      role: user.role,
      kind: input.kind,
      scheduledAt: centralDateTime(input.date, input.time),
      bookedVia: input.bookedVia,
      interviewerUserId: input.interviewerUserId,
    });
  });
}

const rescheduleSchema = timeSchema.extend({ interviewId: uuid });

export async function rescheduleInterviewAction(raw: z.input<typeof rescheduleSchema>): Promise<ActionResult<{ changed: boolean }>> {
  return run(async (user) => {
    const input = rescheduleSchema.parse(raw);
    return rescheduleInterview(db, {
      interviewId: input.interviewId,
      userId: user.id,
      role: user.role,
      kind: input.kind,
      scheduledAt: centralDateTime(input.date, input.time),
      bookedVia: input.bookedVia,
      interviewerUserId: input.interviewerUserId,
    });
  });
}

export async function cancelInterviewAction(raw: { interviewId: string }): Promise<ActionResult<null>> {
  return run(async (user) => {
    const input = z.object({ interviewId: uuid }).parse(raw);
    await cancelInterview(db, { interviewId: input.interviewId, userId: user.id, role: user.role });
    return null;
  });
}

const resultSchema = z.object({
  interviewId: uuid,
  outcome: z.enum(["held", "no_show"]),
  // Central wall-clock date and time it was held; held only.
  heldDate: isoDate.nullable().optional(),
  heldTime: clock.nullable().optional(),
  grades: z.record(z.string().max(60), grade).optional(),
  overallGrade: grade.optional(),
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS).nullable().optional(),
  notes: optionalText(4000),
  notionUrl: optionalText(2000),
});

export async function recordInterviewResultAction(raw: z.input<typeof resultSchema>): Promise<ActionResult<{ changed: boolean }>> {
  return run(async (user) => {
    const input = resultSchema.parse(raw);
    const held = input.outcome === "held";
    return recordInterviewResult(db, {
      interviewId: input.interviewId,
      userId: user.id,
      role: user.role,
      outcome: input.outcome,
      heldAt: held ? centralDateTime(input.heldDate ?? "", input.heldTime ?? "") : null,
      grades: held ? input.grades : {},
      overallGrade: held ? (input.overallGrade ?? null) : null,
      recommendation: held ? (input.recommendation ?? null) : null,
      notes: input.notes ?? null,
      notionUrl: input.notionUrl ?? null,
    });
  });
}

const assessmentSchema = z.object({
  applicationId: uuid,
  assessmentTypeOptionId: uuid,
  result: z.enum(ASSESSMENT_RESULTS),
  administeredOn: isoDate,
  note: optionalText(2000),
});

// Recorded as given by the signed-in staff member.
export async function recordAssessmentAction(raw: z.input<typeof assessmentSchema>): Promise<ActionResult<{ assessmentId: string }>> {
  return run(async (user) => {
    const input = assessmentSchema.parse(raw);
    return recordAssessment(db, { ...input, note: input.note ?? null, userId: user.id, role: user.role });
  });
}

export async function voidAssessmentAction(raw: { assessmentId: string }): Promise<ActionResult<null>> {
  return run(async (user) => {
    const input = z.object({ assessmentId: uuid }).parse(raw);
    await voidAssessment(db, { assessmentId: input.assessmentId, userId: user.id, role: user.role });
    return null;
  });
}
