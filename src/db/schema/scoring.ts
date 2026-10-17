import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { picklistOption, role } from "./config";
import { actorTypeEnum, aiScoreStatusEnum, configStatusEnum, reviewDecisionValueEnum, scoringModeEnum } from "./enums";
import { application, applicationEvent } from "./people";

// AI scoring: rubrics and their versions, scores, and the human screening decision
// (DATA_MODEL.md, "Phase 2 tables"). The AI never moves, closes or rejects an
// application: the scoring module writes only ai_score and ai_criterion_score rows.
// The triggers (review_decision append-only, published rubric versions and their
// criteria locked, completed scores locked) are in drizzle/0008_phase2_triggers_and_grants.sql.

// One entry of a rubric version's fixed, job-related flag list.
export type RubricFlag = { key: string; label: string };

// One per role. The live version is the one published rubric_version (partial unique
// there), so there is no pointer column. Written in the rubric editor, Admin only.
export const rubric = pgTable(
  "rubric",
  {
    id: id(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    // Off for both roles until the owner turns one to hidden or visible.
    scoringMode: scoringModeEnum().notNull().default("off"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("rubric_role_id_unique").on(table.roleId)],
);

// Stable criterion identity across rubric versions, so criterion scores compare over seasons.
export const rubricCriterion = pgTable(
  "rubric_criterion",
  {
    id: id(),
    rubricId: uuid()
      .notNull()
      .references(() => rubric.id),
    key: text().notNull(),
    createdAt: createdAt(),
    archivedAt: timestamptz(),
  },
  (table) => [unique("rubric_criterion_rubric_id_key_unique").on(table.rubricId, table.key)],
);

// One version of a role's rubric. Once published only status may change, to retired (trigger).
export const rubricVersion = pgTable(
  "rubric_version",
  {
    id: id(),
    rubricId: uuid()
      .notNull()
      .references(() => rubric.id),
    version: integer().notNull(),
    status: configStatusEnum().notNull(),
    // Includes "ignore spelling, grammar, length and language" and the ban on protected traits and criminal history.
    instructions: text().notNull(),
    allowedFlags: jsonb().$type<RubricFlag[]>().notNull(),
    // Required to publish: a written reason, not a passing test run (service).
    changeReason: text(),
    publishedAt: timestamptz(),
    publishedBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("rubric_version_rubric_id_version_unique").on(table.rubricId, table.version),
    // The one live version per rubric; publishing the next one retires it in the same transaction.
    uniqueIndex("rubric_version_one_published_per_rubric").on(table.rubricId).where(sql`status = 'published'`),
  ],
);

// A criterion as one rubric version words and weights it. Immutable with its version (trigger).
export const rubricVersionCriterion = pgTable(
  "rubric_version_criterion",
  {
    rubricVersionId: uuid()
      .notNull()
      .references(() => rubricVersion.id),
    criterionId: uuid()
      .notNull()
      .references(() => rubricCriterion.id),
    name: text().notNull(),
    guidanceStrong: text().notNull(),
    guidanceAcceptable: text().notNull(),
    guidanceWeak: text().notNull(),
    // numeric(5,2), read as a number.
    weight: numeric({ mode: "number", precision: 5, scale: 2 }).notNull(),
    // The question lineages (question.id) this criterion reads. The service rejects
    // any lineage with ai_never_send.
    questionIds: uuid().array().notNull(),
    // True when this criterion's guidance asks for something materially different from
    // the previous version; reports stop pooling across it.
    meaningChanged: boolean().notNull().default(false),
    sortOrder: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rubricVersionId, table.criterionId] }),
    check("rubric_version_criterion_weight_positive", sql`${table.weight} > 0`),
  ],
);

// Sample answers keyed by question key, e.g. {"missed_commitment": "..."}.
export type RubricTestAnswers = Record<string, string>;

// Optional sample answers for the rubric editor's "Try it". Cases in one group say the
// same thing in different forms (standard, broken English, very short); results are
// shown side by side and never stored, and nothing here blocks publishing.
export const rubricTestCase = pgTable("rubric_test_case", {
  id: id(),
  rubricId: uuid()
    .notNull()
    .references(() => rubric.id),
  groupKey: text().notNull(),
  // e.g. standard, broken_english, short
  variant: text().notNull(),
  answers: jsonb().$type<RubricTestAnswers>().notNull(),
  createdAt: createdAt(),
  archivedAt: timestamptz(),
});

// Exactly what the scorer was sent: an anonymous id and the answers to the lineages
// the rubric's criteria read. Never a name, phone or email, never an ai_never_send
// question. ScoringInput in src/server/services/scoring/types.ts is this shape.
export type ScoringInputSnapshot = {
  anonymousId: string;
  answers: { criterionKey: string; questionKey: string; prompt: string; answer: string }[];
};

// One scoring of one application against one rubric version. Once completed_at is set
// only is_current may change (trigger).
export const aiScore = pgTable(
  "ai_score",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    rubricVersionId: uuid()
      .notNull()
      .references(() => rubricVersion.id),
    modelId: text().notNull(),
    // Includes the overall-score formula version.
    promptVersion: text().notNull(),
    status: aiScoreStatusEnum().notNull(),
    inputSnapshot: jsonb().$type<ScoringInputSnapshot>().notNull(),
    rawOutput: jsonb(),
    // 1 to 100, computed by the app from the criterion scores and the version's weights,
    // never asked of the model. Set exactly when status is succeeded, so a failed or
    // invalid result is "not scored", never a low number (checks).
    overallScore: smallint(),
    rationale: text(),
    // Keys from the rubric version's allowed_flags only (service).
    flags: text().array(),
    // Protected-trait keyword scan of the rationale; a hit shows as a chip on the profile.
    keywordHits: text().array(),
    isCurrent: boolean().notNull(),
    hiddenFromReviewers: boolean().notNull(),
    // e.g. a re-score after the human decided; left out of the agreement report.
    scoredAfterDecision: boolean().notNull(),
    requestedByType: actorTypeEnum().notNull(),
    requestedByUserId: uuid().references(() => appUser.id),
    inputTokens: integer(),
    outputTokens: integer(),
    error: text(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (table) => [
    // One current score per application.
    uniqueIndex("ai_score_one_current_per_application").on(table.applicationId).where(sql`is_current`),
    index("ai_score_rubric_version_id_idx").on(table.rubricVersionId),
    check("ai_score_overall_score_range", sql`${table.overallScore} is null or ${table.overallScore} between 1 and 100`),
    check("ai_score_overall_score_iff_succeeded", sql`(${table.status} = 'succeeded') = (${table.overallScore} is not null)`),
  ],
);

// One criterion's 1 to 5 grade within a score. A table rather than JSON because the
// predictiveness report groups by criterion across seasons.
export const aiCriterionScore = pgTable(
  "ai_criterion_score",
  {
    aiScoreId: uuid()
      .notNull()
      .references(() => aiScore.id),
    // The service checks it is in the score's rubric version.
    criterionId: uuid()
      .notNull()
      .references(() => rubricCriterion.id),
    score: smallint().notNull(),
    rationale: text(),
  },
  (table) => [
    primaryKey({ columns: [table.aiScoreId, table.criterionId] }),
    check("ai_criterion_score_range", sql`${table.score} between 1 and 5`),
  ],
);

// The human screening decision, kept apart from stage moves so AI-vs-human agreement
// never has to be inferred. Written by the transition that disqualifies, holds or
// advances a scored application (see the rule under review_decision in DATA_MODEL.md).
// Append-only (trigger); the latest row is current.
export const reviewDecision = pgTable(
  "review_decision",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    decision: reviewDecisionValueEnum().notNull(),
    // Required for decline (check), from the disqualify_reason list (service).
    reasonOptionId: uuid().references(() => picklistOption.id),
    note: text(),
    // The current score at decision time, if any, and whether the reviewer could see it.
    aiScoreId: uuid().references(() => aiScore.id),
    aiScoreVisible: boolean().notNull(),
    // The event this decision was recorded with.
    applicationEventId: uuid().references(() => applicationEvent.id),
    decidedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    decidedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("review_decision_application_id_decided_at_idx").on(table.applicationId, table.decidedAt),
    check("review_decision_decline_has_reason", sql`${table.decision} <> 'decline' or ${table.reasonOptionId} is not null`),
  ],
);
