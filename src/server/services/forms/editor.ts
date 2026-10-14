import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  application,
  appUser,
  formItem,
  formVersion,
  question,
  questionVersion,
  role,
  QUESTION_TYPES,
  type FormSection,
  type QuestionOption,
  type QuestionType,
  type QuestionValidation,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";

// The question editor's draft rules (DATA_MODEL.md: question, question_version,
// form_version, form_item, "Report keys never change once used").
//
// One draft form version per role. The draft is created from the published form
// and edited in place: sections live in form_version.sections, questions as
// form_item rows pointing at question versions. A question version that has
// never been published belongs to the draft alone and is edited in place. One
// that has been published is frozen (trigger), so a wording change creates a new
// version in the same lineage ("reworded") or a new lineage ("new question").
// A question's key and role never change; the editor has no such call.
// Option keys are generated once and carried over by key, never reused for a
// different meaning in a lineage. Removing a question only removes the draft's
// item: nothing is archived, so reports keep the lineage. Everything is audited.

export type FormEditorErrorCode =
  | "role_not_found"
  | "form_not_found"
  | "form_not_draft"
  | "draft_exists"
  | "section_not_found"
  | "section_not_empty"
  | "section_title_required"
  | "question_not_in_draft"
  | "question_not_found"
  | "question_wrong_role"
  | "question_already_in_draft"
  | "key_in_use"
  | "invalid_key"
  | "prompt_required"
  | "invalid_type"
  | "options_required"
  | "options_not_allowed"
  | "option_label_required"
  | "lineage_choice_required"
  | "type_change_needs_new_question"
  | "nothing_changed"
  | "empty_form"
  | "duplicate_lineage"
  | "change_reason_required"
  | "no_published_form";

export class FormEditorError extends Error {
  constructor(
    readonly code: FormEditorErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FormEditorError";
  }
}

export type EditorItem = {
  questionId: string;
  key: string;
  aiNeverSend: boolean;
  questionVersionId: string;
  version: number;
  type: QuestionType;
  prompt: string;
  help: string | null;
  options: QuestionOption[] | null;
  validation: QuestionValidation | null;
  meaningChanged: boolean;
  changeNote: string | null;
  // Null while the version has only ever been in a draft.
  publishedAt: Date | null;
  sectionKey: string;
  sortOrder: number;
  required: boolean;
  attentionValues: string[] | null;
};

export type FormSnapshot = {
  id: string;
  roleId: string;
  version: number;
  status: "draft" | "published" | "retired";
  sections: FormSection[];
  aiDisclosureVersionId: string | null;
  changeReason: string | null;
  publishedAt: Date | null;
  publishedBy: { id: string; name: string | null; email: string } | null;
  createdAt: Date;
  // Applications pinned to this version (they keep it to the end).
  applicationCount: number;
  items: EditorItem[];
};

export type FormHistoryEntry = {
  id: string;
  version: number;
  status: "draft" | "published" | "retired";
  publishedAt: Date | null;
  changeReason: string | null;
  applicationCount: number;
};

// A question lineage of the role that is not in the draft, with its latest version,
// so it can be added back without starting a new lineage.
export type AvailableQuestion = {
  questionId: string;
  key: string;
  aiNeverSend: boolean;
  latest: Pick<EditorItem, "questionVersionId" | "version" | "type" | "prompt" | "help" | "options" | "publishedAt">;
};

export type RoleForms = {
  role: { id: string; key: string; internalName: string; title: string };
  published: FormSnapshot | null;
  draft: FormSnapshot | null;
  history: FormHistoryEntry[];
  available: AvailableQuestion[];
};

export type RoleFormSummary = {
  role: { id: string; key: string; internalName: string; title: string };
  published: { version: number; publishedAt: Date | null; itemCount: number } | null;
  draft: { version: number; itemCount: number } | null;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type FormVersionRow = typeof formVersion.$inferSelect;
type QuestionVersionRow = typeof questionVersion.$inferSelect;

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function isValidKey(value: string) {
  return KEY_PATTERN.test(value);
}

// "What is the highest you have worked on a ladder?" -> "what_is_the_highest_you_have"
export function slugKey(text: string, maxLength = 40): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!slug) return "";
  if (slug.length <= maxLength) return slug.replace(/^[0-9]+/, (digits) => `n${digits}`);
  const cut = slug.slice(0, maxLength);
  const atWord = cut.lastIndexOf("_");
  return (atWord > 8 ? cut.slice(0, atWord) : cut).replace(/^[0-9]+/, (digits) => `n${digits}`);
}

// A key that is not in `taken`: the base, else base_2, base_3 and so on.
export function uniqueKey(base: string, taken: ReadonlySet<string>, fallback = "item"): string {
  const root = base || fallback;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function isChoice(type: QuestionType) {
  return type === "single_choice" || type === "multi_choice";
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Reads

async function loadItems(db: Db, formVersionIds: string[]): Promise<Map<string, EditorItem[]>> {
  const byForm = new Map<string, EditorItem[]>();
  if (formVersionIds.length === 0) return byForm;
  const rows = await db
    .select({
      formVersionId: formItem.formVersionId,
      questionId: question.id,
      key: question.key,
      aiNeverSend: question.aiNeverSend,
      questionVersionId: questionVersion.id,
      version: questionVersion.version,
      type: questionVersion.type,
      prompt: questionVersion.prompt,
      help: questionVersion.help,
      options: questionVersion.options,
      validation: questionVersion.validation,
      meaningChanged: questionVersion.meaningChanged,
      changeNote: questionVersion.changeNote,
      publishedAt: questionVersion.publishedAt,
      sectionKey: formItem.sectionKey,
      sortOrder: formItem.sortOrder,
      required: formItem.required,
      attentionValues: formItem.attentionValues,
    })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(inArray(formItem.formVersionId, formVersionIds))
    .orderBy(asc(formItem.sortOrder), asc(question.key));
  for (const { formVersionId: id, ...item } of rows) {
    const list = byForm.get(id) ?? [];
    list.push(item);
    byForm.set(id, list);
  }
  return byForm;
}

async function applicationCounts(db: Db, formVersionIds: string[]): Promise<Map<string, number>> {
  if (formVersionIds.length === 0) return new Map();
  const rows = await db
    .select({ formVersionId: application.formVersionId, n: count() })
    .from(application)
    .where(inArray(application.formVersionId, formVersionIds))
    .groupBy(application.formVersionId);
  return new Map(rows.map((row) => [row.formVersionId, Number(row.n)]));
}

async function snapshotsFor(db: Db, rows: FormVersionRow[]): Promise<FormSnapshot[]> {
  const ids = rows.map((row) => row.id);
  const [items, counts] = await Promise.all([loadItems(db, ids), applicationCounts(db, ids)]);
  const publisherIds = [...new Set(rows.map((row) => row.publishedBy).filter((id): id is string => !!id))];
  const publishers =
    publisherIds.length > 0
      ? await db.select({ id: appUser.id, name: appUser.name, email: appUser.email }).from(appUser).where(inArray(appUser.id, publisherIds))
      : [];
  const publisherById = new Map(publishers.map((user) => [user.id, user]));
  return rows.map((row) => ({
    id: row.id,
    roleId: row.roleId,
    version: row.version,
    status: row.status,
    sections: row.sections,
    aiDisclosureVersionId: row.aiDisclosureVersionId,
    changeReason: row.changeReason,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy ? (publisherById.get(row.publishedBy) ?? null) : null,
    createdAt: row.createdAt,
    applicationCount: counts.get(row.id) ?? 0,
    items: sortItems(row.sections, items.get(row.id) ?? []),
  }));
}

// Items in section order, then sort order; items naming an unknown section go last.
function sortItems(sections: FormSection[], items: EditorItem[]): EditorItem[] {
  const order = new Map(sections.map((section, index) => [section.key, index]));
  return [...items].sort((a, b) => {
    const sa = order.get(a.sectionKey) ?? Number.MAX_SAFE_INTEGER;
    const sb = order.get(b.sectionKey) ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
  });
}

export async function loadFormSnapshot(db: Db, formVersionId: string): Promise<FormSnapshot | null> {
  const rows = await db.select().from(formVersion).where(eq(formVersion.id, formVersionId));
  if (!rows[0]) return null;
  return (await snapshotsFor(db, rows))[0] ?? null;
}

// Everything the editor page shows for one role.
export async function loadRoleForms(db: Db, roleId: string): Promise<RoleForms | null> {
  const [roleRow] = await db
    .select({ id: role.id, key: role.key, internalName: role.internalName, title: role.title })
    .from(role)
    .where(and(eq(role.id, roleId), isNull(role.archivedAt)));
  if (!roleRow) return null;

  const versions = await db.select().from(formVersion).where(eq(formVersion.roleId, roleId)).orderBy(desc(formVersion.version));
  const current = versions.filter((row) => row.status !== "retired");
  const snapshots = await snapshotsFor(db, current);
  const counts = await applicationCounts(
    db,
    versions.map((row) => row.id),
  );
  const published = snapshots.find((snapshot) => snapshot.status === "published") ?? null;
  const draft = snapshots.find((snapshot) => snapshot.status === "draft") ?? null;

  return {
    role: roleRow,
    published,
    draft,
    history: versions.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      publishedAt: row.publishedAt,
      changeReason: row.changeReason,
      applicationCount: counts.get(row.id) ?? 0,
    })),
    available: draft ? await availableQuestions(db, roleId, draft) : [],
  };
}

// Lineages of the role not in the draft, each with its latest version.
async function availableQuestions(db: Db, roleId: string, draft: FormSnapshot): Promise<AvailableQuestion[]> {
  const inDraft = new Set(draft.items.map((item) => item.questionId));
  const rows = await db
    .select({
      questionId: question.id,
      key: question.key,
      aiNeverSend: question.aiNeverSend,
      questionVersionId: questionVersion.id,
      version: questionVersion.version,
      type: questionVersion.type,
      prompt: questionVersion.prompt,
      help: questionVersion.help,
      options: questionVersion.options,
      publishedAt: questionVersion.publishedAt,
    })
    .from(question)
    .innerJoin(questionVersion, eq(questionVersion.questionId, question.id))
    .where(and(eq(question.roleId, roleId), isNull(question.archivedAt)))
    .orderBy(asc(question.key), desc(questionVersion.version));
  const seen = new Set<string>();
  const result: AvailableQuestion[] = [];
  for (const row of rows) {
    if (inDraft.has(row.questionId) || seen.has(row.questionId)) continue;
    seen.add(row.questionId);
    // Only versions that were published can be offered: an unpublished leftover is
    // not a lineage anyone answered, and the draft can simply add a new question.
    if (!row.publishedAt) continue;
    const { questionId, key, aiNeverSend, ...latest } = row;
    result.push({ questionId, key, aiNeverSend, latest });
  }
  return result;
}

// The index page: every role with its published and draft version.
export async function listRoleFormSummaries(db: Db): Promise<RoleFormSummary[]> {
  const roles = await db
    .select({ id: role.id, key: role.key, internalName: role.internalName, title: role.title })
    .from(role)
    .where(isNull(role.archivedAt))
    .orderBy(asc(role.sortOrder));
  if (roles.length === 0) return [];
  const versions = await db
    .select({
      id: formVersion.id,
      roleId: formVersion.roleId,
      version: formVersion.version,
      status: formVersion.status,
      publishedAt: formVersion.publishedAt,
      itemCount: sql<number>`(select count(*) from ${formItem} where ${formItem.formVersionId} = ${formVersion.id})`,
    })
    .from(formVersion)
    .where(
      and(
        inArray(
          formVersion.roleId,
          roles.map((r) => r.id),
        ),
        inArray(formVersion.status, ["draft", "published"]),
      ),
    );
  return roles.map((roleRow) => {
    const published = versions.find((v) => v.roleId === roleRow.id && v.status === "published");
    const draft = versions.find((v) => v.roleId === roleRow.id && v.status === "draft");
    return {
      role: roleRow,
      published: published ? { version: published.version, publishedAt: published.publishedAt, itemCount: Number(published.itemCount) } : null,
      draft: draft ? { version: draft.version, itemCount: Number(draft.itemCount) } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Draft lifecycle

async function lockDraft(tx: Tx, formVersionId: string): Promise<FormVersionRow> {
  const [row] = await tx.select().from(formVersion).where(eq(formVersion.id, formVersionId)).for("update");
  if (!row) throw new FormEditorError("form_not_found", "That form version no longer exists");
  if (row.status !== "draft") {
    throw new FormEditorError("form_not_draft", `Form version ${row.version} is ${row.status} and cannot change`, { status: row.status });
  }
  return row;
}

// Returns the role's draft, creating it from the published form when none exists
// (same sections, same question versions, same required flags). A role with no
// published form gets an empty draft with one section.
export async function ensureDraft(db: Db, input: { roleId: string; actor: Actor }): Promise<FormSnapshot> {
  const id = await db.transaction(async (tx) => {
    const [roleRow] = await tx.select({ id: role.id }).from(role).where(eq(role.id, input.roleId)).for("update");
    if (!roleRow) throw new FormEditorError("role_not_found", "That role no longer exists");

    const versions = await tx.select().from(formVersion).where(eq(formVersion.roleId, input.roleId)).orderBy(desc(formVersion.version));
    const existing = versions.find((row) => row.status === "draft");
    if (existing) return existing.id;

    const published = versions.find((row) => row.status === "published") ?? null;
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const draftId = uuidv7();
    await tx.insert(formVersion).values({
      id: draftId,
      roleId: input.roleId,
      version: nextVersion,
      status: "draft",
      sections: published?.sections ?? [{ key: "basics", title: "Basics" }],
      aiDisclosureVersionId: published?.aiDisclosureVersionId ?? null,
      changeReason: null,
      createdBy: input.actor.type === "staff" ? input.actor.userId : null,
    });

    let copied = 0;
    if (published) {
      const items = await tx.select().from(formItem).where(eq(formItem.formVersionId, published.id));
      if (items.length > 0) {
        await tx.insert(formItem).values(
          items.map((item) => ({
            formVersionId: draftId,
            questionVersionId: item.questionVersionId,
            sectionKey: item.sectionKey,
            sortOrder: item.sortOrder,
            required: item.required,
            attentionValues: item.attentionValues,
          })),
        );
        copied = items.length;
      }
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: "form.draft_create",
      entityType: "form_version",
      entityId: draftId,
      changes: { version: nextVersion, fromVersion: published?.version ?? null, items: copied },
    });
    return draftId;
  });
  const snapshot = await loadFormSnapshot(db, id);
  if (!snapshot) throw new FormEditorError("form_not_found", "The draft could not be read back");
  return snapshot;
}

// Deletes the draft and the never-published question versions that only it used.
// A lineage left with no versions (a question created in this draft) goes too.
export async function discardDraft(db: Db, input: { formVersionId: string; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    const items = await tx.select().from(formItem).where(eq(formItem.formVersionId, draft.id));
    await tx.delete(formItem).where(eq(formItem.formVersionId, draft.id));
    await tx.delete(formVersion).where(eq(formVersion.id, draft.id));

    const versionIds = items.map((item) => item.questionVersionId);
    let removedVersions = 0;
    if (versionIds.length > 0) {
      const unpublished = await tx
        .select({ id: questionVersion.id, questionId: questionVersion.questionId })
        .from(questionVersion)
        .where(and(inArray(questionVersion.id, versionIds), isNull(questionVersion.publishedAt)));
      if (unpublished.length > 0) {
        await tx.delete(questionVersion).where(
          inArray(
            questionVersion.id,
            unpublished.map((row) => row.id),
          ),
        );
        removedVersions = unpublished.length;
        const lineageIds = [...new Set(unpublished.map((row) => row.questionId))];
        const stillVersioned = await tx
          .select({ questionId: questionVersion.questionId })
          .from(questionVersion)
          .where(inArray(questionVersion.questionId, lineageIds));
        const keep = new Set(stillVersioned.map((row) => row.questionId));
        const orphaned = lineageIds.filter((id) => !keep.has(id));
        if (orphaned.length > 0) await tx.delete(question).where(inArray(question.id, orphaned));
      }
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: "form.draft_discard",
      entityType: "form_version",
      entityId: draft.id,
      changes: { version: draft.version, items: items.length, unpublishedVersionsRemoved: removedVersions },
    });
  });
}

// ---------------------------------------------------------------------------
// Sections

async function saveSections(tx: Tx, draft: FormVersionRow, sections: FormSection[], actor: Actor, action: string, changes: Record<string, unknown>) {
  await tx.update(formVersion).set({ sections }).where(eq(formVersion.id, draft.id));
  await writeAudit(tx, { actor, action, entityType: "form_version", entityId: draft.id, changes });
}

export async function addSection(
  db: Db,
  input: { formVersionId: string; title: string; intro?: string | null; actor: Actor },
): Promise<FormSection> {
  const title = input.title.trim();
  if (!title) throw new FormEditorError("section_title_required", "Give the section a title");
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    const taken = new Set(draft.sections.map((section) => section.key));
    const section: FormSection = { key: uniqueKey(slugKey(title, 30), taken, "section"), title };
    const intro = cleanText(input.intro);
    if (intro) section.intro = intro;
    await saveSections(tx, draft, [...draft.sections, section], input.actor, "form.section_add", { section });
    return section;
  });
}

export async function updateSection(
  db: Db,
  input: { formVersionId: string; sectionKey: string; title: string; intro?: string | null; actor: Actor },
): Promise<void> {
  const title = input.title.trim();
  if (!title) throw new FormEditorError("section_title_required", "Give the section a title");
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    const index = draft.sections.findIndex((section) => section.key === input.sectionKey);
    if (index < 0) throw new FormEditorError("section_not_found", "That section is not in the draft");
    const before = draft.sections[index]!;
    const intro = cleanText(input.intro);
    const after: FormSection = { key: before.key, title };
    if (intro) after.intro = intro;
    const sections = draft.sections.map((section, i) => (i === index ? after : section));
    await saveSections(tx, draft, sections, input.actor, "form.section_update", {
      sectionKey: before.key,
      title: { from: before.title, to: after.title },
      intro: { from: before.intro ?? null, to: after.intro ?? null },
    });
  });
}

export async function moveSection(
  db: Db,
  input: { formVersionId: string; sectionKey: string; direction: "up" | "down"; actor: Actor },
): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    const index = draft.sections.findIndex((section) => section.key === input.sectionKey);
    if (index < 0) throw new FormEditorError("section_not_found", "That section is not in the draft");
    const target = input.direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= draft.sections.length) return;
    const sections = [...draft.sections];
    [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    await saveSections(tx, draft, sections, input.actor, "form.section_move", {
      sectionKey: input.sectionKey,
      position: { from: index, to: target },
    });
  });
}

// Only an empty section can go; move or remove its questions first.
export async function removeSection(db: Db, input: { formVersionId: string; sectionKey: string; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    const section = draft.sections.find((s) => s.key === input.sectionKey);
    if (!section) throw new FormEditorError("section_not_found", "That section is not in the draft");
    const [used] = await tx
      .select({ n: count() })
      .from(formItem)
      .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.sectionKey, input.sectionKey)));
    if (Number(used?.n ?? 0) > 0) {
      throw new FormEditorError("section_not_empty", "Move or remove the questions in this section first");
    }
    const sections = draft.sections.filter((s) => s.key !== input.sectionKey);
    await saveSections(tx, draft, sections, input.actor, "form.section_remove", { section });
  });
}

// ---------------------------------------------------------------------------
// Question content

export type OptionInput = {
  // Present when the option already exists in the version being edited; its key
  // is kept. Absent for a new option, whose key is generated here.
  key?: string | null;
  label: string;
};

export type QuestionContent = {
  type: QuestionType;
  prompt: string;
  help?: string | null;
  options?: OptionInput[] | null;
  validation?: QuestionValidation | null;
};

type CleanContent = {
  type: QuestionType;
  prompt: string;
  help: string | null;
  options: QuestionOption[] | null;
  validation: QuestionValidation | null;
};

// Validates the wording and settles option keys: existing keys (those in
// `current`) are kept, new options get a slug key that no earlier version of the
// lineage ever used (`usedKeys`), so a key never comes back with another meaning.
function cleanContent(input: QuestionContent, current: QuestionOption[] | null, usedKeys: ReadonlySet<string>): CleanContent {
  if (!QUESTION_TYPES.includes(input.type)) throw new FormEditorError("invalid_type", "Pick a question type");
  const prompt = input.prompt.trim();
  if (!prompt) throw new FormEditorError("prompt_required", "Write the question");
  const help = cleanText(input.help);

  let options: QuestionOption[] | null = null;
  if (isChoice(input.type)) {
    const given = (input.options ?? []).map((option) => ({ key: option.key?.trim() || null, label: option.label.trim() }));
    if (given.some((option) => !option.label)) throw new FormEditorError("option_label_required", "Every choice needs a label");
    if (given.length < 2) throw new FormEditorError("options_required", "Add at least two choices");
    const currentKeys = new Set((current ?? []).map((option) => option.key));
    const taken = new Set(usedKeys);
    options = [];
    const assigned = new Set<string>();
    // Existing options first so a new option never steals a kept key.
    for (const option of given) {
      if (option.key && currentKeys.has(option.key) && !assigned.has(option.key)) assigned.add(option.key);
    }
    for (const option of given) {
      let key: string;
      if (option.key && currentKeys.has(option.key) && options.every((o) => o.key !== option.key)) {
        key = option.key;
      } else {
        key = uniqueKey(slugKey(option.label, 30), new Set([...taken, ...assigned]), "option");
        assigned.add(key);
      }
      options.push({ key, label: option.label });
    }
  } else if (input.options && input.options.length > 0) {
    throw new FormEditorError("options_not_allowed", "Only choice questions have options");
  }

  const validation = cleanValidation(input.type, input.validation ?? null);
  return { type: input.type, prompt, help, options, validation };
}

function cleanValidation(type: QuestionType, validation: QuestionValidation | null): QuestionValidation | null {
  if (!validation) return null;
  const out: QuestionValidation = {};
  if (type === "number") {
    if (typeof validation.min === "number" && Number.isFinite(validation.min)) out.min = validation.min;
    if (typeof validation.max === "number" && Number.isFinite(validation.max)) out.max = validation.max;
    if (validation.integer) out.integer = true;
  } else if (type === "short_text" || type === "long_text") {
    if (typeof validation.maxLength === "number" && validation.maxLength > 0) out.maxLength = Math.floor(validation.maxLength);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Every option key any version of the lineage has used.
async function lineageOptionKeys(tx: Tx, questionId: string): Promise<Set<string>> {
  const rows = await tx.select({ options: questionVersion.options }).from(questionVersion).where(eq(questionVersion.questionId, questionId));
  const keys = new Set<string>();
  for (const row of rows) for (const option of row.options ?? []) keys.add(option.key);
  return keys;
}

async function roleQuestionKeys(tx: Tx, roleId: string): Promise<Set<string>> {
  const rows = await tx.select({ key: question.key }).from(question).where(eq(question.roleId, roleId));
  return new Set(rows.map((row) => row.key));
}

async function nextSortOrder(tx: Tx, formVersionId: string, sectionKey: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${formItem.sortOrder})` })
    .from(formItem)
    .where(and(eq(formItem.formVersionId, formVersionId), eq(formItem.sectionKey, sectionKey)));
  return (Number(row?.max ?? 0) || 0) + 10;
}

function requireSection(draft: FormVersionRow, sectionKey: string) {
  if (!draft.sections.some((section) => section.key === sectionKey)) {
    throw new FormEditorError("section_not_found", "That section is not in the draft");
  }
}

// Attention values must name real answers: option keys for choices, "true" or
// "false" for yes/no; other types have none.
function cleanAttention(type: QuestionType, options: QuestionOption[] | null, values: string[] | null | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  let allowed: Set<string>;
  if (isChoice(type)) allowed = new Set((options ?? []).map((option) => option.key));
  else if (type === "yes_no") allowed = new Set(["true", "false"]);
  else return null;
  const kept = [...new Set(values.filter((value) => allowed.has(value)))];
  return kept.length > 0 ? kept : null;
}

export type AddQuestionInput = QuestionContent & {
  formVersionId: string;
  sectionKey: string;
  // Optional report key; generated from the prompt when blank. Never changes afterwards.
  key?: string | null;
  required: boolean;
  attentionValues?: string[] | null;
  aiNeverSend?: boolean;
  actor: Actor;
};

// A new lineage with version 1, placed at the end of the section.
export async function addQuestion(db: Db, input: AddQuestionInput): Promise<{ questionId: string; questionVersionId: string; key: string }> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    requireSection(draft, input.sectionKey);
    const content = cleanContent(input, null, new Set());

    const taken = await roleQuestionKeys(tx, draft.roleId);
    let key: string;
    const wanted = input.key?.trim() ?? "";
    if (wanted) {
      if (!isValidKey(wanted)) {
        throw new FormEditorError("invalid_key", "A key is lowercase letters, digits and underscores, starting with a letter");
      }
      if (taken.has(wanted)) throw new FormEditorError("key_in_use", `The key ${wanted} is already used by another question of this role`, { key: wanted });
      key = wanted;
    } else {
      key = uniqueKey(slugKey(content.prompt), taken, "question");
    }

    const questionId = uuidv7();
    const questionVersionId = uuidv7();
    const createdBy = input.actor.type === "staff" ? input.actor.userId : null;
    await tx.insert(question).values({ id: questionId, roleId: draft.roleId, key, aiNeverSend: input.aiNeverSend ?? false });
    await tx.insert(questionVersion).values({
      id: questionVersionId,
      questionId,
      version: 1,
      ...content,
      meaningChanged: false,
      changeNote: null,
      publishedAt: null,
      createdBy,
    });
    await tx.insert(formItem).values({
      formVersionId: draft.id,
      questionVersionId,
      sectionKey: input.sectionKey,
      sortOrder: await nextSortOrder(tx, draft.id, input.sectionKey),
      required: input.required,
      attentionValues: cleanAttention(content.type, content.options, input.attentionValues),
    });
    await writeAudit(tx, {
      actor: input.actor,
      action: "question.create",
      entityType: "question",
      entityId: questionId,
      changes: { formVersionId: draft.id, key, type: content.type, prompt: content.prompt, aiNeverSend: input.aiNeverSend ?? false },
    });
    return { questionId, questionVersionId, key };
  });
}

// Puts a lineage the draft no longer has back in, at its latest version.
export async function addExistingQuestion(
  db: Db,
  input: { formVersionId: string; questionId: string; sectionKey: string; required?: boolean; actor: Actor },
): Promise<{ questionVersionId: string }> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.formVersionId);
    requireSection(draft, input.sectionKey);
    const [lineage] = await tx.select().from(question).where(eq(question.id, input.questionId));
    if (!lineage) throw new FormEditorError("question_not_found", "That question no longer exists");
    if (lineage.roleId !== draft.roleId) throw new FormEditorError("question_wrong_role", "That question belongs to another role");
    const [latest] = await tx
      .select()
      .from(questionVersion)
      .where(eq(questionVersion.questionId, lineage.id))
      .orderBy(desc(questionVersion.version))
      .limit(1);
    if (!latest) throw new FormEditorError("question_not_found", "That question has no version to add");
    const already = await tx
      .select({ questionVersionId: formItem.questionVersionId })
      .from(formItem)
      .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
      .where(and(eq(formItem.formVersionId, draft.id), eq(questionVersion.questionId, lineage.id)));
    if (already.length > 0) throw new FormEditorError("question_already_in_draft", "That question is already in the draft");

    await tx.insert(formItem).values({
      formVersionId: draft.id,
      questionVersionId: latest.id,
      sectionKey: input.sectionKey,
      sortOrder: await nextSortOrder(tx, draft.id, input.sectionKey),
      required: input.required ?? false,
      attentionValues: null,
    });
    await writeAudit(tx, {
      actor: input.actor,
      action: "form.item_add",
      entityType: "form_version",
      entityId: draft.id,
      changes: { questionId: lineage.id, key: lineage.key, questionVersionId: latest.id, version: latest.version, sectionKey: input.sectionKey },
    });
    return { questionVersionId: latest.id };
  });
}

type DraftItem = {
  draft: FormVersionRow;
  item: typeof formItem.$inferSelect;
  version: QuestionVersionRow;
  lineage: typeof question.$inferSelect;
};

async function lockDraftItem(tx: Tx, formVersionId: string, questionVersionId: string): Promise<DraftItem> {
  const draft = await lockDraft(tx, formVersionId);
  const [item] = await tx
    .select()
    .from(formItem)
    .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, questionVersionId)));
  if (!item) throw new FormEditorError("question_not_in_draft", "That question is not in the draft any more; reload the page");
  const [version] = await tx.select().from(questionVersion).where(eq(questionVersion.id, questionVersionId));
  if (!version) throw new FormEditorError("question_not_found", "That question version no longer exists");
  const [lineage] = await tx.select().from(question).where(eq(question.id, version.questionId));
  if (!lineage) throw new FormEditorError("question_not_found", "That question no longer exists");
  return { draft, item, version, lineage };
}

export type EditQuestionInput = QuestionContent & {
  formVersionId: string;
  questionVersionId: string;
  // What a wording change to a published version means. Ignored while the version
  // has never been published, since it is then edited in place.
  //   reworded: a new version of the same question (reports keep pooling unless
  //             meaningChanged is set)
  //   new:      a new question with its own key; the old one leaves the draft
  lineage?: "reworded" | "new";
  meaningChanged?: boolean;
  changeNote?: string | null;
  // For lineage "new": the new question's key, generated from the prompt when blank.
  newKey?: string | null;
  actor: Actor;
};

export type EditQuestionResult =
  | { outcome: "edited_in_place"; questionVersionId: string }
  | { outcome: "reworded"; questionVersionId: string; version: number }
  | { outcome: "new_question"; questionId: string; questionVersionId: string; key: string };

function sameContent(a: CleanContent, version: QuestionVersionRow) {
  return (
    a.type === version.type &&
    a.prompt === version.prompt &&
    (a.help ?? null) === (version.help ?? null) &&
    JSON.stringify(a.options ?? null) === JSON.stringify(version.options ?? null) &&
    JSON.stringify(a.validation ?? null) === JSON.stringify(version.validation ?? null)
  );
}

export async function editQuestion(db: Db, input: EditQuestionInput): Promise<EditQuestionResult> {
  return db.transaction(async (tx) => {
    const { draft, item, version, lineage } = await lockDraftItem(tx, input.formVersionId, input.questionVersionId);
    const createdBy = input.actor.type === "staff" ? input.actor.userId : null;

    // Never published: nothing pins it, so the draft's own version changes in place.
    if (!version.publishedAt) {
      const usedKeys = await lineageOptionKeys(tx, lineage.id);
      for (const option of version.options ?? []) usedKeys.delete(option.key);
      const content = cleanContent(input, version.options, usedKeys);
      if (sameContent(content, version)) return { outcome: "edited_in_place", questionVersionId: version.id };
      await tx.update(questionVersion).set(content).where(eq(questionVersion.id, version.id));
      await tx
        .update(formItem)
        .set({ attentionValues: cleanAttention(content.type, content.options, item.attentionValues) })
        .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, version.id)));
      await writeAudit(tx, {
        actor: input.actor,
        action: "question.version_edit",
        entityType: "question",
        entityId: lineage.id,
        changes: {
          formVersionId: draft.id,
          questionVersionId: version.id,
          prompt: { from: version.prompt, to: content.prompt },
          help: { from: version.help, to: content.help },
          type: { from: version.type, to: content.type },
          options: { from: version.options, to: content.options },
          validation: { from: version.validation, to: content.validation },
        },
      });
      return { outcome: "edited_in_place", questionVersionId: version.id };
    }

    if (input.lineage === "new") {
      const content = cleanContent(input, null, new Set());
      const taken = await roleQuestionKeys(tx, draft.roleId);
      const wanted = input.newKey?.trim() ?? "";
      let key: string;
      if (wanted) {
        if (!isValidKey(wanted)) {
          throw new FormEditorError("invalid_key", "A key is lowercase letters, digits and underscores, starting with a letter");
        }
        if (taken.has(wanted)) throw new FormEditorError("key_in_use", `The key ${wanted} is already used by another question of this role`, { key: wanted });
        key = wanted;
      } else {
        key = uniqueKey(slugKey(content.prompt), taken, "question");
      }
      const questionId = uuidv7();
      const questionVersionId = uuidv7();
      // The protective flag follows the replacement; an Admin can clear it on purpose.
      await tx.insert(question).values({ id: questionId, roleId: draft.roleId, key, aiNeverSend: lineage.aiNeverSend });
      await tx.insert(questionVersion).values({
        id: questionVersionId,
        questionId,
        version: 1,
        ...content,
        meaningChanged: false,
        changeNote: cleanText(input.changeNote),
        publishedAt: null,
        createdBy,
      });
      await tx.delete(formItem).where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, version.id)));
      await tx.insert(formItem).values({
        formVersionId: draft.id,
        questionVersionId,
        sectionKey: item.sectionKey,
        sortOrder: item.sortOrder,
        required: item.required,
        attentionValues: cleanAttention(content.type, content.options, item.attentionValues),
      });
      await writeAudit(tx, {
        actor: input.actor,
        action: "question.replace",
        entityType: "question",
        entityId: questionId,
        changes: {
          formVersionId: draft.id,
          replacesQuestionId: lineage.id,
          replacesKey: lineage.key,
          key,
          type: content.type,
          prompt: { from: version.prompt, to: content.prompt },
          aiNeverSend: lineage.aiNeverSend,
        },
      });
      return { outcome: "new_question", questionId, questionVersionId, key };
    }

    if (input.lineage !== "reworded") {
      throw new FormEditorError(
        "lineage_choice_required",
        "This wording has been published. Say whether it is the same question reworded or a new question",
      );
    }
    if (input.type !== version.type) {
      throw new FormEditorError("type_change_needs_new_question", "Changing the answer type makes it a new question", {
        from: version.type,
        to: input.type,
      });
    }
    const usedKeys = await lineageOptionKeys(tx, lineage.id);
    const content = cleanContent(input, version.options, usedKeys);
    if (sameContent(content, version) && !input.meaningChanged) {
      throw new FormEditorError("nothing_changed", "Nothing changed");
    }
    const [latest] = await tx
      .select({ version: questionVersion.version })
      .from(questionVersion)
      .where(eq(questionVersion.questionId, lineage.id))
      .orderBy(desc(questionVersion.version))
      .limit(1);
    const nextVersion = (latest?.version ?? version.version) + 1;
    const questionVersionId = uuidv7();
    await tx.insert(questionVersion).values({
      id: questionVersionId,
      questionId: lineage.id,
      version: nextVersion,
      ...content,
      meaningChanged: input.meaningChanged ?? false,
      changeNote: cleanText(input.changeNote),
      publishedAt: null,
      createdBy,
    });
    await tx.delete(formItem).where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, version.id)));
    await tx.insert(formItem).values({
      formVersionId: draft.id,
      questionVersionId,
      sectionKey: item.sectionKey,
      sortOrder: item.sortOrder,
      required: item.required,
      attentionValues: cleanAttention(content.type, content.options, item.attentionValues),
    });
    await writeAudit(tx, {
      actor: input.actor,
      action: "question.reword",
      entityType: "question",
      entityId: lineage.id,
      changes: {
        formVersionId: draft.id,
        key: lineage.key,
        version: { from: version.version, to: nextVersion },
        meaningChanged: input.meaningChanged ?? false,
        prompt: { from: version.prompt, to: content.prompt },
        help: { from: version.help, to: content.help },
        options: { from: version.options, to: content.options },
        validation: { from: version.validation, to: content.validation },
      },
    });
    return { outcome: "reworded", questionVersionId, version: nextVersion };
  });
}

// The form_item fields: required, attention values and which section it sits in
// (a moved question goes to the end of its new section). No new version.
export async function updateItem(
  db: Db,
  input: {
    formVersionId: string;
    questionVersionId: string;
    required?: boolean;
    attentionValues?: string[] | null;
    sectionKey?: string;
    actor: Actor;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { draft, item, version } = await lockDraftItem(tx, input.formVersionId, input.questionVersionId);
    const set: Partial<typeof formItem.$inferInsert> = {};
    const changes: Record<string, unknown> = { questionVersionId: version.id };
    if (input.required !== undefined && input.required !== item.required) {
      set.required = input.required;
      changes.required = { from: item.required, to: input.required };
    }
    if (input.attentionValues !== undefined) {
      const next = cleanAttention(version.type, version.options, input.attentionValues);
      if (JSON.stringify(next) !== JSON.stringify(item.attentionValues)) {
        set.attentionValues = next;
        changes.attentionValues = { from: item.attentionValues, to: next };
      }
    }
    if (input.sectionKey !== undefined && input.sectionKey !== item.sectionKey) {
      requireSection(draft, input.sectionKey);
      set.sectionKey = input.sectionKey;
      set.sortOrder = await nextSortOrder(tx, draft.id, input.sectionKey);
      changes.sectionKey = { from: item.sectionKey, to: input.sectionKey };
    }
    if (Object.keys(set).length === 0) return;
    await tx
      .update(formItem)
      .set(set)
      .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, version.id)));
    await writeAudit(tx, { actor: input.actor, action: "form.item_update", entityType: "form_version", entityId: draft.id, changes });
  });
}

// Swaps the question with its neighbour in the same section and renumbers the section.
export async function moveQuestion(
  db: Db,
  input: { formVersionId: string; questionVersionId: string; direction: "up" | "down"; actor: Actor },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { draft, item } = await lockDraftItem(tx, input.formVersionId, input.questionVersionId);
    const siblings = await tx
      .select({ questionVersionId: formItem.questionVersionId, sortOrder: formItem.sortOrder })
      .from(formItem)
      .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.sectionKey, item.sectionKey)))
      .orderBy(asc(formItem.sortOrder), asc(formItem.questionVersionId));
    const index = siblings.findIndex((s) => s.questionVersionId === item.questionVersionId);
    const target = input.direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    const order = siblings.map((s) => s.questionVersionId);
    [order[index], order[target]] = [order[target]!, order[index]!];
    for (let i = 0; i < order.length; i++) {
      await tx
        .update(formItem)
        .set({ sortOrder: (i + 1) * 10 })
        .where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, order[i]!)));
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "form.item_move",
      entityType: "form_version",
      entityId: draft.id,
      changes: { questionVersionId: item.questionVersionId, sectionKey: item.sectionKey, position: { from: index, to: target } },
    });
  });
}

// Takes the question out of the draft. The lineage, its versions and every answer
// stay, so reports and old applications are untouched; nothing is archived.
export async function removeQuestion(db: Db, input: { formVersionId: string; questionVersionId: string; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const { draft, version, lineage } = await lockDraftItem(tx, input.formVersionId, input.questionVersionId);
    await tx.delete(formItem).where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, version.id)));
    await writeAudit(tx, {
      actor: input.actor,
      action: "form.item_remove",
      entityType: "form_version",
      entityId: draft.id,
      changes: { questionId: lineage.id, key: lineage.key, questionVersionId: version.id, version: version.version },
    });
  });
}

// The deny list on top of whatever a rubric asks for (DATA_MODEL.md, question.ai_never_send).
// Per lineage, so every version is covered. Admin only at the action layer; audited here.
export async function setAiNeverSend(db: Db, input: { questionId: string; value: boolean; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const [lineage] = await tx.select().from(question).where(eq(question.id, input.questionId)).for("update");
    if (!lineage) throw new FormEditorError("question_not_found", "That question no longer exists");
    if (lineage.aiNeverSend === input.value) return;
    await tx.update(question).set({ aiNeverSend: input.value }).where(eq(question.id, lineage.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: "question.ai_never_send",
      entityType: "question",
      entityId: lineage.id,
      changes: { key: lineage.key, aiNeverSend: { from: lineage.aiNeverSend, to: input.value } },
    });
  });
}
