import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import {
  answer,
  application,
  applicationEvent,
  entryCode,
  formItem,
  formVersion,
  groupSession,
  MILESTONES,
  person,
  picklistOption,
  pipelineStage,
  question,
  questionVersion,
  type Milestone,
  type QuestionOption,
} from "@/db/schema";
import { effectiveEvents } from "../applications/replay";
import { formatPhoneNational, type CsvCell } from "../csv";
import { checkStartsWith } from "../forms/starts-with";
import { replySpeedByPerson } from "../messaging/reply-speed";
import {
  boolCell,
  centralIso,
  ExportError,
  inChunks,
  listCell,
  timestampRange,
  type ExportContext,
  type ExportTable,
} from "./shared";

// The per-opening wide export: one row per application with the person, the
// source and entry code, the session, the cached state, the first time each
// milestone was reached (from the event log, skipped milestones counting as
// reached by a later one) and one column per question version answered in the
// opening, labeled "<key> (v<version>)". Choice answers get a second column with
// the option labels, and a lineage with a starting-word check gets "<key> check"
// (pass, fail or blank) after its last version. Group interview arrival and the
// person's text reply speed sit with the session columns. Restricted notes never
// appear here; no notes do.

const FIXED_HEADERS = [
  "application_id",
  "person_id",
  "first_name",
  "last_name",
  "mobile",
  "email",
  "origin",
  "status",
  "on_hold",
  "stage_key",
  "stage_name",
  "stage_milestone",
  "stage_entered_at",
  "closed_outcome",
  "closed_reason_key",
  "closed_reason_label",
  "exclude_from_analysis",
  "source",
  "source_detail",
  "entry_channel",
  "entry_code",
  "entry_code_label",
  "scanned_session_id",
  "attributed_session_id",
  "attributed_session_starts_at",
  "attributed_session_location",
  "attribution_method",
  "group_interview_arrival",
  "median_text_reply_minutes",
  "text_reply_count",
  "indeed_applied_on",
  "language",
  "form_version",
  "started_at",
  "submitted_at",
  "last_activity_at",
  ...MILESTONES.map((m) => `reached_${m}_at`),
];

type QuestionColumn = {
  questionVersionId: string;
  key: string;
  version: number;
  type: (typeof questionVersion.$inferSelect)["type"];
  options: QuestionOption[] | null;
  startsWithCheck: string | null;
};

// Where an item sits on its form: the section's place in form_version.sections,
// then sort_order, which the editor numbers within each section.
type FormPosition = { section: number; sortOrder: number };

function comparePositions(a: FormPosition, b: FormPosition): number {
  return a.section - b.section || a.sortOrder - b.sortOrder;
}

const CHOICE_TYPES = new Set(["single_choice", "multi_choice"]);

export async function applicationsWide(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const op = ctx.opening;
  if (!op) throw new ExportError("opening_required", "Pick an opening for this export");

  const stages = await db.select().from(pipelineStage).where(eq(pipelineStage.roleId, op.roleId));
  const milestoneByStage = new Map(stages.map((stage) => [stage.id, stage.milestone]));

  const closedReason = alias(picklistOption, "closed_reason");
  const attributed = alias(groupSession, "attributed_session");
  const apps = await db
    .select({
      app: application,
      firstName: person.firstName,
      lastName: person.lastName,
      mobile: person.mobileE164,
      email: person.email,
      stageKey: pipelineStage.key,
      stageName: pipelineStage.name,
      stageMilestone: pipelineStage.milestone,
      reasonKey: closedReason.key,
      reasonLabel: closedReason.label,
      entryCode: entryCode.code,
      entryCodeLabel: entryCode.label,
      attributedStartsAt: attributed.startsAt,
      attributedLocation: attributed.locationName,
      formVersion: formVersion.version,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .innerJoin(formVersion, eq(formVersion.id, application.formVersionId))
    .leftJoin(closedReason, eq(closedReason.id, application.closedReasonOptionId))
    .leftJoin(entryCode, eq(entryCode.id, application.entryCodeId))
    .leftJoin(attributed, eq(attributed.id, application.attributedSessionId))
    .where(and(eq(application.openingId, op.id), isNull(application.deletedAt), timestampRange(application.startedAt, ctx.range)))
    .orderBy(asc(application.startedAt), asc(application.id));

  const ids = apps.map((row) => row.app.id);
  const reached = await milestoneTimes(db, ids, milestoneByStage);
  const columns = await questionColumns(db, [...new Set(apps.map((row) => row.app.formVersionId))]);
  const answers = await loadAnswers(db, ids);
  const replySpeeds = await replySpeedByPerson(
    db,
    apps.map((row) => row.app.personId),
  );
  const checked = new Set(columns.filter((c) => c.startsWithCheck).map((c) => c.key));
  // A lineage's check column follows its last version column.
  const endsLineage = (index: number) => columns[index + 1]?.key !== columns[index]!.key;

  const headers = [...FIXED_HEADERS];
  columns.forEach((column, index) => {
    headers.push(columnHeader(column));
    if (CHOICE_TYPES.has(column.type)) headers.push(`${columnHeader(column)} label`);
    if (checked.has(column.key) && endsLineage(index)) headers.push(checkHeader(column.key));
  });

  const rows: CsvCell[][] = apps.map((row) => {
    const a = row.app;
    const times = reached.get(a.id) ?? new Map<Milestone, Date>();
    const cells: CsvCell[] = [
      a.id,
      a.personId,
      row.firstName,
      row.lastName,
      formatPhoneNational(row.mobile),
      row.email,
      a.origin,
      a.status,
      boolCell(a.onHold),
      row.stageKey,
      row.stageName,
      row.stageMilestone,
      centralIso(a.stageEnteredAt),
      a.closedOutcome,
      row.reasonKey,
      row.reasonLabel,
      boolCell(a.excludeFromAnalysis),
      a.source,
      a.sourceDetail,
      a.entryChannel,
      row.entryCode,
      row.entryCodeLabel,
      a.scannedSessionId,
      a.attributedSessionId,
      centralIso(row.attributedStartsAt),
      row.attributedLocation,
      a.attributionMethod,
      a.groupInterviewArrival,
      replySpeeds.get(a.personId)?.medianMinutes ?? null,
      replySpeeds.get(a.personId)?.replies ?? 0,
      a.indeedAppliedOn,
      a.language,
      row.formVersion,
      centralIso(a.startedAt),
      centralIso(a.submittedAt),
      centralIso(a.lastActivityAt),
      ...MILESTONES.map((m) => centralIso(times.get(m))),
    ];
    let check: CsvCell = "";
    columns.forEach((column, index) => {
      const found = answers.get(`${a.id}:${column.questionVersionId}`);
      cells.push(answerValue(column, found));
      if (CHOICE_TYPES.has(column.type)) cells.push(answerLabels(column, found));
      // The version this application answered decides its check.
      if (found && column.startsWithCheck) check = checkResult(column.startsWithCheck, found);
      if (checked.has(column.key) && endsLineage(index)) {
        cells.push(check);
        check = "";
      }
    });
    return cells;
  });

  return { headers, rows };
}

export function columnHeader(column: Pick<QuestionColumn, "key" | "version">): string {
  return `${column.key} (v${column.version})`;
}

export function checkHeader(key: string): string {
  return `${key} check`;
}

// "pass", "fail", or blank when the question has no check or no answer.
export function checkResult(startsWithCheck: string | null, row: Pick<AnswerRow, "valueText"> | undefined): string {
  return (startsWithCheck && row ? checkStartsWith(row.valueText, startsWithCheck) : null) ?? "";
}

// The first non-voided event that moved the application to a stage whose
// milestone is at or after M, for each milestone M (DATA_MODEL.md, "How each
// report is computed").
async function milestoneTimes(
  db: Db,
  applicationIds: string[],
  milestoneByStage: Map<string, Milestone | null>,
): Promise<Map<string, Map<Milestone, Date>>> {
  const events = await inChunks(applicationIds, (chunk) =>
    db.select().from(applicationEvent).where(inArray(applicationEvent.applicationId, chunk)),
  );
  const byApplication = new Map<string, typeof events>();
  for (const event of events) {
    const list = byApplication.get(event.applicationId) ?? [];
    list.push(event);
    byApplication.set(event.applicationId, list);
  }

  const result = new Map<string, Map<Milestone, Date>>();
  for (const [applicationId, list] of byApplication) {
    const times = new Map<Milestone, Date>();
    for (const event of effectiveEvents(list)) {
      if (!event.toStageId) continue;
      const milestone = milestoneByStage.get(event.toStageId);
      if (!milestone) continue;
      const index = MILESTONES.indexOf(milestone);
      for (let i = 0; i <= index; i++) {
        const m = MILESTONES[i]!;
        const current = times.get(m);
        if (!current || event.occurredAt.getTime() < current.getTime()) times.set(m, event.occurredAt);
      }
    }
    result.set(applicationId, times);
  }
  return result;
}

// One column per question version used by the pinned forms, ordered by where the
// lineage first appears on the form (section order, then sort order within the
// section, the same order the question editor shows), then key, then version.
async function questionColumns(db: Db, formVersionIds: string[]): Promise<QuestionColumn[]> {
  if (formVersionIds.length === 0) return [];
  const items = await db
    .select({
      questionVersionId: questionVersion.id,
      key: question.key,
      version: questionVersion.version,
      type: questionVersion.type,
      options: questionVersion.options,
      startsWithCheck: questionVersion.startsWithCheck,
      sectionKey: formItem.sectionKey,
      sections: formVersion.sections,
      sortOrder: formItem.sortOrder,
    })
    .from(formItem)
    .innerJoin(formVersion, eq(formVersion.id, formItem.formVersionId))
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(inArray(formItem.formVersionId, formVersionIds));

  const byVersion = new Map<string, QuestionColumn>();
  const lineagePosition = new Map<string, FormPosition>();
  for (const { sectionKey, sections, sortOrder, ...column } of items) {
    if (!byVersion.has(column.questionVersionId)) byVersion.set(column.questionVersionId, column);
    // An item naming a section the form does not list goes last, as in the editor.
    const index = sections.findIndex((section) => section.key === sectionKey);
    const position = { section: index === -1 ? Number.MAX_SAFE_INTEGER : index, sortOrder };
    const first = lineagePosition.get(column.key);
    if (!first || comparePositions(position, first) < 0) lineagePosition.set(column.key, position);
  }
  return [...byVersion.values()].sort(
    (a, b) =>
      comparePositions(lineagePosition.get(a.key)!, lineagePosition.get(b.key)!) ||
      a.key.localeCompare(b.key) ||
      a.version - b.version,
  );
}

type AnswerRow = typeof answer.$inferSelect;

async function loadAnswers(db: Db, applicationIds: string[]): Promise<Map<string, AnswerRow>> {
  const rows = await inChunks(applicationIds, (chunk) =>
    db.select().from(answer).where(inArray(answer.applicationId, chunk)),
  );
  return new Map(rows.map((row) => [`${row.applicationId}:${row.questionVersionId}`, row]));
}

// Choice answers export their option keys; labels sit in the companion column.
export function answerValue(column: Pick<QuestionColumn, "type">, row: AnswerRow | undefined): CsvCell {
  if (!row) return "";
  switch (column.type) {
    case "short_text":
    case "long_text":
      return row.valueText;
    case "number":
      return row.valueNumber;
    case "date":
      return row.valueDate;
    case "yes_no":
      return boolCell(row.valueBool);
    case "single_choice":
    case "multi_choice":
      return listCell(row.valueOptions);
  }
}

export function answerLabels(column: Pick<QuestionColumn, "options">, row: AnswerRow | undefined): string {
  if (!row?.valueOptions?.length) return "";
  return listCell(row.valueOptions.map((key) => optionLabel(column.options, key)));
}

export function optionLabel(options: QuestionOption[] | null | undefined, key: string): string {
  return options?.find((option) => option.key === key)?.label ?? key;
}
