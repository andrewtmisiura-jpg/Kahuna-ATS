"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { QUESTION_TYPES } from "@/db/schema";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { staffActor, type Actor } from "@/server/services/actor";
import {
  addExistingQuestion,
  addQuestion,
  addSection,
  discardDraft,
  editQuestion,
  ensureDraft,
  FormEditorError,
  moveQuestion,
  moveSection,
  removeQuestion,
  removeSection,
  setAiNeverSend,
  updateItem,
  updateSection,
} from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";

// Server actions for the question editor. Each one checks the Admin role, parses
// its input, calls a forms service and refreshes the editor pages. Known errors
// come back as a result the dialogs can show; anything else propagates.

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const direction = z.enum(["up", "down"]);

const optionSchema = z.object({ key: z.string().trim().max(80).nullish(), label: text(200) });

const validationSchema = z
  .object({
    min: z.number().finite().nullish(),
    max: z.number().finite().nullish(),
    integer: z.boolean().nullish(),
    maxLength: z.number().int().positive().nullish(),
  })
  .partial();

const contentSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  prompt: text(2000),
  help: text(2000).nullish(),
  options: z.array(optionSchema).max(50).nullish(),
  validation: validationSchema.nullish(),
});

const attentionSchema = z.array(z.string().trim().max(80)).max(50).nullish();

function stripNulls(validation: z.infer<typeof validationSchema> | null | undefined) {
  if (!validation) return null;
  const out: { min?: number; max?: number; integer?: boolean; maxLength?: number } = {};
  if (typeof validation.min === "number") out.min = validation.min;
  if (typeof validation.max === "number") out.max = validation.max;
  if (validation.integer) out.integer = true;
  if (typeof validation.maxLength === "number") out.maxLength = validation.maxLength;
  return out;
}

function refresh(roleId: string) {
  revalidatePath("/admin/questions");
  revalidatePath(`/admin/questions/${roleId}`);
}

function isImmutableViolation(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e?.cause?.code ?? e?.code) === "TP002";
}

// Admin check first, then the input, then the service, then a refresh of the pages.
async function run<S extends z.ZodType<{ roleId: string }>, T>(
  schema: S,
  input: unknown,
  fn: (parsed: z.output<S>, actor: Actor) => Promise<T>,
): Promise<ActionResult<T>> {
  let roleId: string | undefined;
  try {
    const user = await requireRole("admin");
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    roleId = parsed.data.roleId;
    const data = await fn(parsed.data, staffActor(user.id));
    refresh(roleId);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof FormEditorError) {
      if (roleId) refresh(roleId);
      return { ok: false, code: error.code, message: error.message, details: error.details };
    }
    if (error instanceof NotSignedInError) return { ok: false, code: "not_signed_in", message: "You are signed out. Sign in again." };
    if (error instanceof AccessDeniedError) return { ok: false, code: "access_denied", message: "Only an Admin can change questions." };
    if (isImmutableViolation(error)) {
      if (roleId) refresh(roleId);
      return { ok: false, code: "published", message: "That version was published and cannot change. Reload the page." };
    }
    throw error;
  }
}

const withRole = z.object({ roleId: uuid });
const withDraft = withRole.extend({ formVersionId: uuid });
const withSection = withDraft.extend({ sectionKey: z.string().min(1) });
const withItem = withDraft.extend({ questionVersionId: uuid });

export async function createDraftAction(input: { roleId: string }): Promise<ActionResult<{ formVersionId: string }>> {
  return run(withRole, input, async (p, actor) => {
    const draft = await ensureDraft(db, { roleId: p.roleId, actor });
    return { formVersionId: draft.id };
  });
}

export async function discardDraftAction(input: { roleId: string; formVersionId: string }): Promise<ActionResult> {
  return run(withDraft, input, async (p, actor) => {
    await discardDraft(db, { formVersionId: p.formVersionId, actor });
    return undefined;
  });
}

const sectionFields = { title: text(120), intro: text(500).nullish() };

export async function addSectionAction(input: {
  roleId: string;
  formVersionId: string;
  title: string;
  intro?: string | null;
}): Promise<ActionResult<{ key: string }>> {
  return run(withDraft.extend(sectionFields), input, async (p, actor) => {
    const section = await addSection(db, { ...p, actor });
    return { key: section.key };
  });
}

export async function updateSectionAction(input: {
  roleId: string;
  formVersionId: string;
  sectionKey: string;
  title: string;
  intro?: string | null;
}): Promise<ActionResult> {
  return run(withSection.extend(sectionFields), input, async (p, actor) => {
    await updateSection(db, { ...p, actor });
    return undefined;
  });
}

export async function moveSectionAction(input: {
  roleId: string;
  formVersionId: string;
  sectionKey: string;
  direction: "up" | "down";
}): Promise<ActionResult> {
  return run(withSection.extend({ direction }), input, async (p, actor) => {
    await moveSection(db, { ...p, actor });
    return undefined;
  });
}

export async function removeSectionAction(input: { roleId: string; formVersionId: string; sectionKey: string }): Promise<ActionResult> {
  return run(withSection, input, async (p, actor) => {
    await removeSection(db, { ...p, actor });
    return undefined;
  });
}

const addQuestionInput = withSection.extend(contentSchema.shape).extend({
  key: text(64).nullish(),
  required: z.boolean(),
  attentionValues: attentionSchema,
  aiNeverSend: z.boolean().optional(),
});

export type AddQuestionActionInput = z.input<typeof addQuestionInput>;

export async function addQuestionAction(
  input: AddQuestionActionInput,
): Promise<ActionResult<{ questionId: string; questionVersionId: string; key: string }>> {
  return run(addQuestionInput, input, (p, actor) => addQuestion(db, { ...p, validation: stripNulls(p.validation), actor }));
}

export async function addExistingQuestionAction(input: {
  roleId: string;
  formVersionId: string;
  questionId: string;
  sectionKey: string;
}): Promise<ActionResult> {
  return run(withSection.extend({ questionId: uuid }), input, async (p, actor) => {
    await addExistingQuestion(db, { ...p, actor });
    return undefined;
  });
}

const saveQuestionInput = withItem.extend(contentSchema.shape).extend({
  lineage: z.enum(["reworded", "new"]).optional(),
  meaningChanged: z.boolean().optional(),
  changeNote: text(500).nullish(),
  newKey: text(64).nullish(),
  required: z.boolean(),
  attentionValues: attentionSchema,
  sectionKey: z.string().min(1).optional(),
});

export type SaveQuestionActionInput = z.input<typeof saveQuestionInput>;

// Wording first (which may move the item to a new question version), then the
// item's own fields: required, attention values and section.
export async function saveQuestionAction(
  input: SaveQuestionActionInput,
): Promise<ActionResult<{ outcome: string; questionVersionId: string }>> {
  return run(saveQuestionInput, input, async (p, actor) => {
    const edited = await editQuestion(db, { ...p, validation: stripNulls(p.validation), actor });
    await updateItem(db, {
      formVersionId: p.formVersionId,
      questionVersionId: edited.questionVersionId,
      required: p.required,
      attentionValues: p.attentionValues ?? null,
      sectionKey: p.sectionKey,
      actor,
    });
    return { outcome: edited.outcome, questionVersionId: edited.questionVersionId };
  });
}

export async function moveQuestionAction(input: {
  roleId: string;
  formVersionId: string;
  questionVersionId: string;
  direction: "up" | "down";
}): Promise<ActionResult> {
  return run(withItem.extend({ direction }), input, async (p, actor) => {
    await moveQuestion(db, { ...p, actor });
    return undefined;
  });
}

export async function removeQuestionAction(input: { roleId: string; formVersionId: string; questionVersionId: string }): Promise<ActionResult> {
  return run(withItem, input, async (p, actor) => {
    await removeQuestion(db, { ...p, actor });
    return undefined;
  });
}

export async function setAiNeverSendAction(input: { roleId: string; questionId: string; value: boolean }): Promise<ActionResult> {
  return run(withRole.extend({ questionId: uuid, value: z.boolean() }), input, async (p, actor) => {
    await setAiNeverSend(db, { questionId: p.questionId, value: p.value, actor });
    return undefined;
  });
}

export async function publishFormAction(input: {
  roleId: string;
  formVersionId: string;
  changeReason: string;
}): Promise<ActionResult<{ version: number; previousVersion: number | null }>> {
  return run(withDraft.extend({ changeReason: text(2000) }), input, async (p, actor) => {
    const result = await publishForm(db, { formVersionId: p.formVersionId, changeReason: p.changeReason, actor });
    return { version: result.version, previousVersion: result.previous?.version ?? null };
  });
}
