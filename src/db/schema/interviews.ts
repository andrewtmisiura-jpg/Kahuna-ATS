import { sql } from "drizzle-orm";
import { date, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { picklistOption } from "./config";
import {
  assessmentResultEnum,
  interviewGradeValueEnum,
  interviewKindEnum,
  interviewRecommendationEnum,
  interviewStatusEnum,
} from "./enums";
import { application } from "./people";

// Interviews, their grades and assessments such as the ladder test
// (DATA_MODEL.md, "Phase 2 tables": interview, interview_grade, assessment).

// How an interview was booked. Plain text, not an enum, so a new way needs no
// migration; the service accepts only these.
export const INTERVIEW_BOOKED_VIA = ["booking_link", "phone", "in_person"] as const;
export type InterviewBookedVia = (typeof INTERVIEW_BOOKED_VIA)[number];

// A one-on-one or phone screen: when, with whom, the overall grade and the recommendation.
export const interview = pgTable(
  "interview",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    kind: interviewKindEnum().notNull(),
    status: interviewStatusEnum().notNull(),
    scheduledAt: timestamptz(),
    bookedVia: text().$type<InterviewBookedVia>(),
    interviewerUserId: uuid().references(() => appUser.id),
    heldAt: timestamptz(),
    overallGrade: interviewGradeValueEnum(),
    recommendation: interviewRecommendationEnum(),
    // No medical observations.
    notes: text(),
    notionUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
    redactedAt: timestamptz(),
  },
  (table) => [
    index("interview_application_id_idx").on(table.applicationId),
    index("interview_scheduled_at_idx").on(table.scheduledAt),
  ],
);

// One grade per scorecard category. Category keys are configuration, not an enum.
export const interviewGrade = pgTable(
  "interview_grade",
  {
    interviewId: uuid()
      .notNull()
      .references(() => interview.id),
    categoryKey: text().notNull(),
    grade: interviewGradeValueEnum().notNull(),
  },
  (table) => [primaryKey({ columns: [table.interviewId, table.categoryKey] })],
);

// The ladder test and any later per-role test. Types come from the assessment_type
// picklist, so a new test needs no schema change.
export const assessment = pgTable(
  "assessment",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    assessmentTypeOptionId: uuid()
      .notNull()
      .references(() => picklistOption.id),
    result: assessmentResultEnum().notNull(),
    administeredBy: uuid()
      .notNull()
      .references(() => appUser.id),
    administeredOn: date({ mode: "string" }).notNull(),
    // Restricted. Never medical observations.
    note: text(),
    // A correction voids the result and records a new one.
    voidedAt: timestamptz(),
    createdAt: createdAt(),
    redactedAt: timestamptz(),
  },
  (table) => [
    // One live result per test per application.
    uniqueIndex("assessment_one_live_per_type")
      .on(table.applicationId, table.assessmentTypeOptionId)
      .where(sql`voided_at is null`),
  ],
);
