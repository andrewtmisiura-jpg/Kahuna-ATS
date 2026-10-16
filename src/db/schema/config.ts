import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, phoneUsCheck, timestamptz, updatedAt } from "./columns";
import {
  channelEnum,
  configStatusEnum,
  legalTextKindEnum,
  messagePurposeEnum,
  milestoneEnum,
  openingStatusEnum,
  picklistKeyEnum,
  questionTypeEnum,
  separationTypeEnum,
} from "./enums";

// Configuration tables: employer, roles, openings, pipelines, questions, forms,
// legal text, templates and picklists (DATA_MODEL.md, "Configuration").

// The legal employer and the brand applicants see. Seeded with Kahuna only.
export const employer = pgTable(
  "employer",
  {
    id: id(),
    key: text().notNull().unique(),
    legalName: text().notNull(),
    displayName: text().notNull(),
    websiteUrl: text(),
    hiringHost: text().notNull(),
    logoUrl: text(),
    emailFromName: text().notNull(),
    emailFromAddress: text(),
    replyToAddress: text(),
    // Quo phone number id of the hiring number; null until quo:connect fills it.
    smsQuoPhoneNumberId: text(),
    smsEnabled: boolean().notNull().default(false),
    smsFromE164: text("sms_from_e164"),
    dailySendCap: integer().notNull().default(200),
    helpContact: text(),
    timezone: text().notNull().default("America/Chicago"),
    // The one-on-one booking link that invites carry as {booking_link}. The service accepts https only.
    bookingLinkUrl: text(),
    // AI scoring calls per Central day across all roles; jobs past it wait for the next day.
    scoringDailyCap: integer().notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz(),
  },
  (table) => [
    phoneUsCheck("employer_sms_from_e164_phone_us", table.smsFromE164),
    check("employer_scoring_daily_cap_positive", sql`${table.scoringDailyCap} > 0`),
  ],
);

// Permanent job definition: pipeline, questions, rubric.
export const role = pgTable(
  "role",
  {
    id: id(),
    employerId: uuid()
      .notNull()
      .references(() => employer.id),
    key: text().notNull(),
    internalName: text().notNull(),
    title: text().notNull(),
    summary: text(),
    usesGroupInterview: boolean().notNull(),
    sortOrder: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz(),
  },
  (table) => [unique("role_employer_id_key_unique").on(table.employerId, table.key)],
);

// One role in one season: the cohort for funnels and retention.
export const opening = pgTable(
  "opening",
  {
    id: id(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    key: text().notNull(),
    name: text().notNull(),
    status: openingStatusEnum().notNull(),
    opensOn: date({ mode: "string" }),
    closesOn: date({ mode: "string" }),
    // Required before retention is reported for this opening (service rule).
    seasonStartOn: date({ mode: "string" }),
    seasonEndOn: date({ mode: "string" }),
    targetHeadcount: integer(),
    payText: text(),
    benefitsText: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("opening_role_id_key_unique").on(table.roleId, table.key),
    // One open opening per role, so a role QR always resolves.
    uniqueIndex("opening_one_open_per_role").on(table.roleId).where(sql`status = 'open'`),
  ],
);

// Configurable stages per role, each mapped to a fixed milestone.
export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: id(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    key: text().notNull(),
    name: text().notNull(),
    publicLabel: text().notNull(),
    // Null for custom stages like "Phone screen".
    milestone: milestoneEnum(),
    sortOrder: integer().notNull(),
    // Started and Submitted: the app moves applications into them; can't be archived.
    isSystem: boolean().notNull().default(false),
    showOnBoard: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz(),
  },
  (table) => [
    unique("pipeline_stage_role_id_key_unique").on(table.roleId, table.key),
    index("pipeline_stage_role_id_sort_order_idx").on(table.roleId, table.sortOrder),
  ],
);

// Question lineage: the stable identity of a question across rewordings.
export const question = pgTable(
  "question",
  {
    id: id(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    key: text().notNull(),
    // Never sent to the AI scorer, whatever a rubric asks for.
    aiNeverSend: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz(),
  },
  (table) => [unique("question_role_id_key_unique").on(table.roleId, table.key)],
);

export type QuestionOption = { key: string; label: string };
export type QuestionValidation = {
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
};

// Exact wording, type and options of one version of a question.
// Immutable once published_at is set (trigger in the custom migration).
export const questionVersion = pgTable(
  "question_version",
  {
    id: id(),
    questionId: uuid()
      .notNull()
      .references(() => question.id),
    version: integer().notNull(),
    type: questionTypeEnum().notNull(),
    prompt: text().notNull(),
    help: text(),
    options: jsonb().$type<QuestionOption[]>(),
    validation: jsonb().$type<QuestionValidation>(),
    // True when this version asks something materially different; reports stop pooling across it.
    meaningChanged: boolean().notNull().default(false),
    changeNote: text(),
    // Staff-only "What to look for" notes. Never shown to applicants, never sent to AI.
    staffGuidance: text(),
    // When set, the answer passes if it starts with this word (see forms/starts-with.ts).
    // Text questions only.
    startsWithCheck: text(),
    publishedAt: timestamptz(),
    createdBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("question_version_question_id_version_unique").on(table.questionId, table.version),
    check(
      "question_version_options_iff_choice",
      sql`(${table.options} is not null) = (${table.type} in ('single_choice', 'multi_choice'))`,
    ),
    check(
      "question_version_starts_with_check_text_only",
      sql`${table.startsWithCheck} is null or ${table.type} in ('short_text', 'long_text')`,
    ),
  ],
);

// Versioned consent text, privacy policy, SMS terms, landing notice and AI disclosure.
// Immutable once published (trigger).
export const legalTextVersion = pgTable(
  "legal_text_version",
  {
    id: id(),
    employerId: uuid()
      .notNull()
      .references(() => employer.id),
    kind: legalTextKindEnum().notNull(),
    version: integer().notNull(),
    body: text().notNull(),
    changeNote: text(),
    publishedAt: timestamptz(),
    publishedBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("legal_text_version_employer_id_kind_version_unique").on(table.employerId, table.kind, table.version),
  ],
);

export type FormSection = { key: string; title: string; intro?: string };

// An immutable snapshot of a role's application form. Once published only
// status may change, to retired (trigger).
export const formVersion = pgTable(
  "form_version",
  {
    id: id(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    version: integer().notNull(),
    status: configStatusEnum().notNull(),
    sections: jsonb().$type<FormSection[]>().notNull(),
    // The AI disclosure this form shows on its landing page.
    aiDisclosureVersionId: uuid().references(() => legalTextVersion.id),
    changeReason: text(),
    publishedAt: timestamptz(),
    publishedBy: uuid().references(() => appUser.id),
    createdBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("form_version_role_id_version_unique").on(table.roleId, table.version),
    // The one live form per role that new applications pin.
    uniqueIndex("form_version_one_published_per_role").on(table.roleId).where(sql`status = 'published'`),
  ],
);

// Which question versions a form version contains, where, and whether required.
// Immutable with its form version (same trigger).
export const formItem = pgTable(
  "form_item",
  {
    formVersionId: uuid()
      .notNull()
      .references(() => formVersion.id),
    questionVersionId: uuid()
      .notNull()
      .references(() => questionVersion.id),
    sectionKey: text().notNull(),
    sortOrder: integer().notNull(),
    required: boolean().notNull(),
    // Answer values that show a warning chip on the profile and list. Never acted on automatically.
    attentionValues: text().array(),
  },
  (table) => [primaryKey({ columns: [table.formVersionId, table.questionVersionId] })],
);

// A named message with its purpose, channel and text. Not versioned: message.body
// stores the text as sent. The partial unique index with nulls not distinct on
// (employer_id, role_id, purpose, channel) where archived_at is null lives in the
// custom migration, since drizzle cannot declare it.
export const messageTemplate = pgTable("message_template", {
  id: id(),
  employerId: uuid()
    .notNull()
    .references(() => employer.id),
  // Null = all roles of the employer.
  roleId: uuid().references(() => role.id),
  purpose: messagePurposeEnum().notNull(),
  channel: channelEnum().notNull(),
  name: text().notNull(),
  subject: text(),
  body: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamptz(),
});

// All small staff-facing picklists in one table.
export const picklistOption = pgTable(
  "picklist_option",
  {
    id: id(),
    listKey: picklistKeyEnum().notNull(),
    // Null = all employers.
    employerId: uuid().references(() => employer.id),
    // Null = all roles of the employer.
    roleId: uuid().references(() => role.id),
    key: text().notNull(),
    label: text().notNull(),
    requiresNote: boolean().notNull().default(false),
    // True for background-based disqualify reasons; triggers the FCRA guard.
    fcraAdverse: boolean().notNull().default(false),
    // Leave reasons only; pre-fills voluntary or involuntary.
    defaultSeparation: separationTypeEnum(),
    sortOrder: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz(),
  },
  (table) => [
    unique("picklist_option_list_key_employer_id_role_id_key_unique")
      .on(table.listKey, table.employerId, table.roleId, table.key)
      .nullsNotDistinct(),
  ],
);
