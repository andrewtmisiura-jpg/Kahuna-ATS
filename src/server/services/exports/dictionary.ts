import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  employer,
  formItem,
  formVersion,
  messageTemplate,
  opening,
  picklistOption,
  pipelineStage,
  question,
  questionVersion,
  role,
} from "@/db/schema";
import { boolCell, centralIso, jsonCell, type ExportTable } from "./shared";

// Dictionary files, so the long files can be read outside the app: openings with
// their roles and season dates, stages with milestones, picklist options, question
// versions with prompt text, option keys and labels, the starting-word check and
// the staff notes on what to look for, and templates. No filters.

export async function openingsDictionary(db: Db): Promise<ExportTable> {
  const rows = await db
    .select({ o: opening, roleKey: role.key, roleTitle: role.title, employerKey: employer.key })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .innerJoin(employer, eq(employer.id, role.employerId))
    .orderBy(asc(role.sortOrder), asc(opening.createdAt));
  return {
    headers: [
      "opening_id",
      "opening_key",
      "name",
      "status",
      "employer_key",
      "role_key",
      "role_title",
      "opens_on",
      "closes_on",
      "season_start_on",
      "season_end_on",
      "target_headcount",
      "pay_text",
      "benefits_text",
    ],
    rows: rows.map((row) => [
      row.o.id,
      row.o.key,
      row.o.name,
      row.o.status,
      row.employerKey,
      row.roleKey,
      row.roleTitle,
      row.o.opensOn,
      row.o.closesOn,
      row.o.seasonStartOn,
      row.o.seasonEndOn,
      row.o.targetHeadcount,
      row.o.payText,
      row.o.benefitsText,
    ]),
  };
}

export async function stagesDictionary(db: Db): Promise<ExportTable> {
  const rows = await db
    .select({ s: pipelineStage, roleKey: role.key })
    .from(pipelineStage)
    .innerJoin(role, eq(role.id, pipelineStage.roleId))
    .orderBy(asc(role.sortOrder), asc(pipelineStage.sortOrder));
  return {
    headers: [
      "stage_id",
      "role_key",
      "stage_key",
      "name",
      "public_label",
      "milestone",
      "sort_order",
      "is_system",
      "show_on_board",
      "archived_at",
    ],
    rows: rows.map((row) => [
      row.s.id,
      row.roleKey,
      row.s.key,
      row.s.name,
      row.s.publicLabel,
      row.s.milestone,
      row.s.sortOrder,
      boolCell(row.s.isSystem),
      boolCell(row.s.showOnBoard),
      centralIso(row.s.archivedAt),
    ]),
  };
}

export async function picklistOptionsDictionary(db: Db): Promise<ExportTable> {
  const rows = await db
    .select({ p: picklistOption, employerKey: employer.key, roleKey: role.key })
    .from(picklistOption)
    .leftJoin(employer, eq(employer.id, picklistOption.employerId))
    .leftJoin(role, eq(role.id, picklistOption.roleId))
    .orderBy(asc(picklistOption.listKey), asc(picklistOption.sortOrder), asc(picklistOption.key));
  return {
    headers: [
      "option_id",
      "list_key",
      "employer_key",
      "role_key",
      "key",
      "label",
      "requires_note",
      "fcra_adverse",
      "default_separation",
      "sort_order",
      "archived_at",
    ],
    rows: rows.map((row) => [
      row.p.id,
      row.p.listKey,
      row.employerKey,
      row.roleKey,
      row.p.key,
      row.p.label,
      boolCell(row.p.requiresNote),
      boolCell(row.p.fcraAdverse),
      row.p.defaultSeparation,
      row.p.sortOrder,
      centralIso(row.p.archivedAt),
    ]),
  };
}

// One row per question version, repeated once per option for choice questions,
// with the form versions each question version appears in.
export async function questionsDictionary(db: Db): Promise<ExportTable> {
  const versions = await db
    .select({
      v: questionVersion,
      roleKey: role.key,
      questionKey: question.key,
      aiNeverSend: question.aiNeverSend,
      questionArchivedAt: question.archivedAt,
    })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .innerJoin(role, eq(role.id, question.roleId))
    .orderBy(asc(role.sortOrder), asc(question.key), asc(questionVersion.version));
  const uses = await db
    .select({ questionVersionId: formItem.questionVersionId, formVersion: formVersion.version, formStatus: formVersion.status })
    .from(formItem)
    .innerJoin(formVersion, eq(formVersion.id, formItem.formVersionId))
    .orderBy(asc(formVersion.version));
  const formsByVersion = new Map<string, string[]>();
  for (const use of uses) {
    const list = formsByVersion.get(use.questionVersionId) ?? [];
    list.push(`v${use.formVersion} (${use.formStatus})`);
    formsByVersion.set(use.questionVersionId, list);
  }

  const headers = [
    "question_version_id",
    "role_key",
    "question_key",
    "ai_never_send",
    "version",
    "type",
    "prompt",
    "help",
    "option_key",
    "option_label",
    "validation",
    "starts_with_check",
    "staff_guidance",
    "meaning_changed",
    "change_note",
    "published_at",
    "in_form_versions",
    "question_archived_at",
  ];
  const rows: ExportTable["rows"] = [];
  for (const row of versions) {
    const base = (optionKey: string | null, optionLabel: string | null) => [
      row.v.id,
      row.roleKey,
      row.questionKey,
      boolCell(row.aiNeverSend),
      row.v.version,
      row.v.type,
      row.v.prompt,
      row.v.help,
      optionKey,
      optionLabel,
      jsonCell(row.v.validation),
      row.v.startsWithCheck,
      row.v.staffGuidance,
      boolCell(row.v.meaningChanged),
      row.v.changeNote,
      centralIso(row.v.publishedAt),
      (formsByVersion.get(row.v.id) ?? []).join("; "),
      centralIso(row.questionArchivedAt),
    ];
    if (row.v.options?.length) {
      for (const option of row.v.options) rows.push(base(option.key, option.label));
    } else {
      rows.push(base(null, null));
    }
  }
  return { headers, rows };
}

export async function templatesDictionary(db: Db): Promise<ExportTable> {
  const rows = await db
    .select({ t: messageTemplate, employerKey: employer.key, roleKey: role.key })
    .from(messageTemplate)
    .innerJoin(employer, eq(employer.id, messageTemplate.employerId))
    .leftJoin(role, eq(role.id, messageTemplate.roleId))
    .orderBy(asc(messageTemplate.purpose), asc(messageTemplate.channel), asc(messageTemplate.createdAt));
  return {
    headers: ["template_id", "employer_key", "role_key", "purpose", "channel", "name", "subject", "body", "archived_at", "updated_at"],
    rows: rows.map((row) => [
      row.t.id,
      row.employerKey,
      row.roleKey,
      row.t.purpose,
      row.t.channel,
      row.t.name,
      row.t.subject,
      row.t.body,
      centralIso(row.t.archivedAt),
      centralIso(row.t.updatedAt),
    ]),
  };
}
