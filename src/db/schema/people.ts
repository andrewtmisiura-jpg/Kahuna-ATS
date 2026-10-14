import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, phoneUsCheck, timestamptz, updatedAt } from "./columns";
import { formVersion, opening, picklistOption, pipelineStage, questionVersion, role } from "./config";
import { entryCode, groupSession } from "./entry";
import {
  actorTypeEnum,
  applicationEventKindEnum,
  applicationOriginEnum,
  applicationStatusEnum,
  attributionMethodEnum,
  closedOutcomeEnum,
  entryChannelEnum,
  sourceEnum,
} from "./enums";

// People, applications, answers, the event log, notes and landing conflicts
// (DATA_MODEL.md, "People and applications").

// The human, independent of any opening, with their contact details.
export const person = pgTable(
  "person",
  {
    id: id(),
    firstName: text(),
    lastName: text(),
    mobileE164: text("mobile_e164"),
    // As typed; staff fix an email from the profile.
    email: text(),
    emailNormalized: text(),
    // Staff set it when two people really share one phone; such a number matches by email only.
    sharedMobile: boolean().notNull().default(false),
    // Set by a merge, always pointing at a root.
    mergedIntoPersonId: uuid().references((): AnyPgColumn => person.id),
    doNotContact: boolean().notNull().default(false),
    preferredLanguage: text().notNull().default("en"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
    // Stamped by the Phase 3 purge; present now because the name check below reads it.
    redactedAt: timestamptz(),
  },
  (table) => [
    uniqueIndex("person_one_per_unshared_mobile")
      .on(table.mobileE164)
      .where(sql`mobile_e164 is not null and not shared_mobile`),
    index("person_email_normalized_idx").on(table.emailNormalized),
    index("person_merged_into_person_id_idx").on(table.mergedIntoPersonId),
    phoneUsCheck("person_mobile_e164_phone_us", table.mobileE164),
    check(
      "person_name_required_unless_redacted",
      sql`${table.redactedAt} is not null or (${table.firstName} is not null and ${table.lastName} is not null)`,
    ),
    check("person_not_merged_into_self", sql`${table.mergedIntoPersonId} <> ${table.id}`),
  ],
);

// One person applying to one opening.
export const application = pgTable(
  "application",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    openingId: uuid()
      .notNull()
      .references(() => opening.id),
    // Ordinary column for queries; the service sets it from the opening.
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    // Pinned at creation; the service only pins the role's published form.
    formVersionId: uuid()
      .notNull()
      .references(() => formVersion.id),
    origin: applicationOriginEnum().notNull(),
    status: applicationStatusEnum().notNull().default("open"),
    closedOutcome: closedOutcomeEnum(),
    closedReasonOptionId: uuid().references(() => picklistOption.id),
    // Cache of the latest event.
    currentStageId: uuid()
      .notNull()
      .references(() => pipelineStage.id),
    stageEnteredAt: timestamptz().notNull(),
    onHold: boolean().notNull().default(false),
    // seq of the latest event; the UI sends it back with a move.
    eventSeq: integer().notNull().default(0),
    answersLocked: boolean().notNull().default(false),
    startedAt: timestamptz().notNull(),
    submittedAt: timestamptz(),
    lastActivityAt: timestamptz().notNull(),
    language: text().notNull().default("en"),
    entryCodeId: uuid().references(() => entryCode.id),
    entryChannel: entryChannelEnum().notNull(),
    scannedSessionId: uuid().references(() => groupSession.id),
    attributedSessionId: uuid().references(() => groupSession.id),
    attributionMethod: attributionMethodEnum().notNull().default("none"),
    source: sourceEnum(),
    sourceDetail: text(),
    sourceSetBy: actorTypeEnum(),
    indeedAppliedOn: date({ mode: "string" }),
    excludeFromAnalysis: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
  },
  (table) => [
    uniqueIndex("application_one_per_person_per_opening")
      .on(table.personId, table.openingId)
      .where(sql`deleted_at is null`),
    index("application_opening_id_status_current_stage_id_idx").on(table.openingId, table.status, table.currentStageId),
    index("application_submitted_at_idx").on(table.submittedAt),
    index("application_attributed_session_id_idx").on(table.attributedSessionId),
    index("application_last_activity_at_unsubmitted_idx").on(table.lastActivityAt).where(sql`submitted_at is null`),
    check("application_closed_has_outcome", sql`(${table.status} = 'closed') = (${table.closedOutcome} is not null)`),
    check(
      "application_closed_has_reason",
      sql`${table.closedOutcome} is null or ${table.closedReasonOptionId} is not null`,
    ),
  ],
);

// One answer to one question version. Values are typed; choices store option keys.
export const answer = pgTable(
  "answer",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    questionVersionId: uuid()
      .notNull()
      .references(() => questionVersion.id),
    valueText: text(),
    valueNumber: numeric(),
    valueDate: date({ mode: "string" }),
    valueBool: boolean(),
    valueOptions: text().array(),
    // Each save sends the revision it last saw; the server updates only when it matches.
    revision: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("answer_application_id_question_version_id_unique").on(table.applicationId, table.questionVersionId),
    index("answer_question_version_id_idx").on(table.questionVersionId),
    check(
      "answer_one_value_column",
      sql`num_nonnulls(${table.valueText}, ${table.valueNumber}, ${table.valueDate}, ${table.valueBool}, ${table.valueOptions}) <= 1`,
    ),
  ],
);

// Written by the transition function: the FCRA facts behind a closure, and the
// rows a move created or voided so that voiding the move can undo them.
export type ApplicationEventMetadata = {
  background_check_ids?: string[];
  not_report_based?: boolean;
  offer_id?: string;
  background_check_id?: string;
  hire_stint_id?: string;
  voided_hire_stint_id?: string;
  rescinded_hire_stint_id?: string;
  [key: string]: unknown;
};

// Append-only log of everything that moves an application (trigger in the custom migration).
export const applicationEvent = pgTable(
  "application_event",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    // 1, 2, 3 per application; defines order.
    seq: integer().notNull(),
    kind: applicationEventKindEnum().notNull(),
    fromStageId: uuid().references(() => pipelineStage.id),
    toStageId: uuid().references(() => pipelineStage.id),
    fromStatus: applicationStatusEnum(),
    toStatus: applicationStatusEnum(),
    closedOutcome: closedOutcomeEnum(),
    reasonOptionId: uuid().references(() => picklistOption.id),
    note: text(),
    // On event_voided, marks an earlier event as a mistake.
    voidsEventId: uuid().references((): AnyPgColumn => applicationEvent.id),
    actorType: actorTypeEnum().notNull(),
    actorUserId: uuid().references(() => appUser.id),
    // When it happened. Staff may backdate.
    occurredAt: timestamptz().notNull(),
    // When it was entered; always the database's entry time.
    recordedAt: timestamptz().notNull().defaultNow(),
    // Groups a bulk move.
    batchId: uuid(),
    metadata: jsonb().$type<ApplicationEventMetadata>(),
  },
  (table) => [
    unique("application_event_application_id_seq_unique").on(table.applicationId, table.seq),
    index("application_event_application_id_occurred_at_idx").on(table.applicationId, table.occurredAt),
    index("application_event_to_stage_id_occurred_at_idx").on(table.toStageId, table.occurredAt),
    index("application_event_kind_occurred_at_idx").on(table.kind, table.occurredAt),
    check(
      "application_event_occurred_not_future",
      sql`${table.occurredAt} <= ${table.recordedAt} + interval '5 minutes'`,
    ),
    check("application_event_staff_has_user", sql`${table.actorType} <> 'staff' or ${table.actorUserId} is not null`),
    check(
      "application_event_closed_has_outcome_and_reason",
      sql`${table.kind} <> 'closed' or (${table.closedOutcome} is not null and ${table.reasonOptionId} is not null)`,
    ),
    check("application_event_voided_names_event", sql`${table.kind} <> 'event_voided' or ${table.voidsEventId} is not null`),
  ],
);

// Staff notes. Append-only in the UI: soft-delete and add a corrected note.
export const note = pgTable(
  "note",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    applicationId: uuid().references(() => application.id),
    // Null only after redaction.
    body: text(),
    // Accommodation or health information: Admin and Hiring Manager only, never exported, never sent to AI.
    isRestricted: boolean().notNull().default(false),
    authorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: createdAt(),
    deletedAt: timestamptz(),
  },
  (table) => [
    index("note_application_id_created_at_idx").on(table.applicationId, table.createdAt),
    index("note_person_id_idx").on(table.personId),
  ],
);

// A landing attempt whose mobile and email point at different people.
export const landingConflict = pgTable(
  "landing_conflict",
  {
    id: id(),
    openingId: uuid()
      .notNull()
      .references(() => opening.id),
    entryCodeId: uuid().references(() => entryCode.id),
    typedFirstName: text(),
    typedLastName: text(),
    typedMobileE164: text("typed_mobile_e164"),
    typedEmail: text(),
    matchedPersonIds: uuid().array().notNull(),
    resolvedAt: timestamptz(),
    resolvedBy: uuid().references(() => appUser.id),
    // "updated email on file" or "marked phone shared".
    resolution: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index("landing_conflict_opening_id_unresolved_idx").on(table.openingId).where(sql`resolved_at is null`),
    phoneUsCheck("landing_conflict_typed_mobile_e164_phone_us", table.typedMobileE164),
  ],
);
