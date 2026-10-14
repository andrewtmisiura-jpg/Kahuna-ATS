import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import {
  answer,
  application,
  formItem,
  formVersion,
  opening,
  pipelineStage,
  question,
  questionVersion,
  role,
  type FormSection,
  type QuestionOption,
  type QuestionValidation,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { APPLICANT_ACTOR } from "../actor";
import { queueMessage, SendError } from "../messaging/send";
import { transition, TransitionError } from "./transition";

// Autosave and submit (DATA_MODEL.md, answer: "Autosave and submit"). Each save
// carries the revision the device last saw and the server updates only when it
// matches, so a stale device never overwrites a newer answer. Submit locks the
// application row, applies any unsaved values, checks the required items, writes
// the submitted event through the transition function and queues the
// confirmation email, all in one transaction.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AnswerRow = typeof answer.$inferSelect;
type QuestionType = (typeof questionVersion.$inferSelect)["type"];

// What the client sends and gets back for one answer. Choices carry option keys.
export type AnswerValue = string | number | boolean | string[] | null;

export type AnswersErrorCode =
  | "application_not_found"
  | "answers_locked"
  | "application_not_open"
  | "question_not_in_form"
  | "invalid_value"
  | "already_submitted"
  | "required_missing";

export class AnswersError extends Error {
  constructor(
    readonly code: AnswersErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AnswersError";
  }
}

export type FormQuestion = {
  questionVersionId: string;
  questionKey: string;
  sectionKey: string;
  sortOrder: number;
  required: boolean;
  type: QuestionType;
  prompt: string;
  help: string | null;
  options: QuestionOption[] | null;
  validation: QuestionValidation | null;
};

export type StoredAnswer = { questionVersionId: string; value: AnswerValue; revision: number };

export type ApplicationForm = {
  applicationId: string;
  roleTitle: string;
  openingName: string;
  status: (typeof application.$inferSelect)["status"];
  submittedAt: Date | null;
  answersLocked: boolean;
  source: (typeof application.$inferSelect)["source"];
  stagePublicLabel: string;
  sections: FormSection[];
  questions: FormQuestion[];
  answers: StoredAnswer[];
};

// Everything the /apply page needs: the pinned form's sections and questions in
// order, the answers so far and the application's state.
export async function loadApplicationForm(db: Db, applicationId: string): Promise<ApplicationForm | null> {
  const [app] = await db
    .select({
      id: application.id,
      status: application.status,
      submittedAt: application.submittedAt,
      answersLocked: application.answersLocked,
      source: application.source,
      formVersionId: application.formVersionId,
      deletedAt: application.deletedAt,
      roleTitle: role.title,
      openingName: opening.name,
      stagePublicLabel: pipelineStage.publicLabel,
      sections: formVersion.sections,
    })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .innerJoin(formVersion, eq(formVersion.id, application.formVersionId))
    .where(eq(application.id, applicationId));
  if (!app || app.deletedAt) return null;

  const questions = await loadFormQuestions(db, app.formVersionId);
  const rows = await db.select().from(answer).where(eq(answer.applicationId, applicationId));
  const byVersion = new Map(questions.map((q) => [q.questionVersionId, q]));
  const answers: StoredAnswer[] = [];
  for (const row of rows) {
    const q = byVersion.get(row.questionVersionId);
    if (q) answers.push({ questionVersionId: row.questionVersionId, value: valueOf(row, q.type), revision: row.revision });
  }

  return {
    applicationId: app.id,
    roleTitle: app.roleTitle,
    openingName: app.openingName,
    status: app.status,
    submittedAt: app.submittedAt,
    answersLocked: app.answersLocked,
    source: app.source,
    stagePublicLabel: app.stagePublicLabel,
    sections: app.sections,
    questions,
    answers,
  };
}

async function loadFormQuestions(db: Db, formVersionId: string): Promise<FormQuestion[]> {
  const rows = await db
    .select({
      questionVersionId: formItem.questionVersionId,
      questionKey: question.key,
      sectionKey: formItem.sectionKey,
      sortOrder: formItem.sortOrder,
      required: formItem.required,
      type: questionVersion.type,
      prompt: questionVersion.prompt,
      help: questionVersion.help,
      options: questionVersion.options,
      validation: questionVersion.validation,
    })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(eq(formItem.formVersionId, formVersionId))
    .orderBy(asc(formItem.sortOrder));
  return rows;
}

// ---------------------------------------------------------------------------
// Autosave

export type SaveAnswerInput = {
  applicationId: string;
  questionVersionId: string;
  // The revision the device last saw: 0 when it has never saved this answer.
  revision: number;
  value: AnswerValue;
  now?: Date;
};

export type SaveAnswerResult =
  | { ok: true; revision: number; value: AnswerValue }
  // Someone saved a newer value first; the device shows it and continues from there.
  | { ok: false; reason: "stale"; revision: number; value: AnswerValue };

export async function saveAnswer(db: Db, input: SaveAnswerInput): Promise<SaveAnswerResult> {
  return db.transaction(async (tx) => {
    const app = await loadOpenApplication(tx, input.applicationId);
    const q = await questionInForm(tx, app.formVersionId, input.questionVersionId);
    const columns = columnsFor(q, input.value);
    const now = input.now ?? new Date();
    const result = await compareAndSet(tx, app.id, q.questionVersionId, input.revision, columns, now);
    await tx.update(application).set({ lastActivityAt: now, updatedAt: now }).where(eq(application.id, app.id));
    return result.ok
      ? { ok: true, revision: result.row.revision, value: valueOf(result.row, q.type) }
      : { ok: false, reason: "stale", revision: result.row.revision, value: valueOf(result.row, q.type) };
  });
}

type ValueColumns = Pick<typeof answer.$inferInsert, "valueText" | "valueNumber" | "valueDate" | "valueBool" | "valueOptions">;

// One row per (application, question version). A first save inserts at revision 1
// when the device saw 0; a later save updates only when the stored revision is the
// one the device saw. A miss returns the current row untouched.
async function compareAndSet(
  tx: Tx,
  applicationId: string,
  questionVersionId: string,
  seen: number,
  columns: ValueColumns,
  now: Date,
): Promise<{ ok: boolean; row: AnswerRow }> {
  if (seen === 0) {
    const inserted = await tx
      .insert(answer)
      .values({ id: uuidv7(), applicationId, questionVersionId, ...columns, revision: 1, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [answer.applicationId, answer.questionVersionId] })
      .returning();
    if (inserted[0]) return { ok: true, row: inserted[0] };
  } else {
    const updated = await tx
      .update(answer)
      .set({ ...columns, revision: sql`${answer.revision} + 1`, updatedAt: now })
      .where(and(eq(answer.applicationId, applicationId), eq(answer.questionVersionId, questionVersionId), eq(answer.revision, seen)))
      .returning();
    if (updated[0]) return { ok: true, row: updated[0] };
  }
  const [current] = await tx
    .select()
    .from(answer)
    .where(and(eq(answer.applicationId, applicationId), eq(answer.questionVersionId, questionVersionId)));
  if (!current) {
    // The device saw a revision for a row that does not exist: treat it as never saved.
    return compareAndSet(tx, applicationId, questionVersionId, 0, columns, now);
  }
  return { ok: false, row: current };
}

// ---------------------------------------------------------------------------
// Submit

export type SubmitInput = {
  applicationId: string;
  employerId: string;
  // Values the device had not saved yet; applied before the required check.
  pending?: Array<{ questionVersionId: string; revision: number; value: AnswerValue }>;
  // The end-of-form "How did you hear about us?" answer, asked only when the landing form left it blank.
  source?: { source: NonNullable<(typeof application.$inferSelect)["source"]>; sourceDetail?: string | null } | null;
  now?: Date;
};

export type SubmitResult = {
  applicationId: string;
  submittedAt: Date;
  // The queued confirmation email, for processMessages inside the request.
  queued: string[];
};

export async function submitApplication(db: Db, input: SubmitInput): Promise<SubmitResult> {
  return db.transaction(async (tx) => {
    const now = input.now ?? new Date();
    // The row lock holds until commit, so a late autosave waits and then sees answers_locked.
    const [app] = await tx.select().from(application).where(eq(application.id, input.applicationId)).for("update");
    if (!app || app.deletedAt) throw new AnswersError("application_not_found", "No such application");
    if (app.submittedAt || app.answersLocked) throw new AnswersError("already_submitted", "This application was already sent");
    if (app.status !== "open") throw new AnswersError("application_not_open", "This application is closed");

    const questions = await loadFormQuestions(tx, app.formVersionId);
    const byVersion = new Map(questions.map((q) => [q.questionVersionId, q]));

    for (const pending of input.pending ?? []) {
      const q = byVersion.get(pending.questionVersionId);
      if (!q) throw new AnswersError("question_not_in_form", "That question is not on this form");
      // A stale pending value loses to the newer one already stored; the newer one is what the applicant saw last.
      await compareAndSet(tx, app.id, q.questionVersionId, pending.revision, columnsFor(q, pending.value), now);
    }

    const rows = await tx.select().from(answer).where(eq(answer.applicationId, app.id));
    const stored = new Map(rows.map((row) => [row.questionVersionId, row]));
    const missing = questions.filter((q) => q.required && isEmpty(valueOf(stored.get(q.questionVersionId) ?? null, q.type)));
    if (missing.length > 0) {
      throw new AnswersError("required_missing", "Some required questions are not answered", {
        missing: missing.map((q) => q.questionVersionId),
      });
    }

    if (input.source && !app.source) {
      await tx
        .update(application)
        .set({
          source: input.source.source,
          sourceDetail: input.source.sourceDetail?.trim() || null,
          sourceSetBy: "applicant",
          excludeFromAnalysis: input.source.source === "current_employee" ? true : app.excludeFromAnalysis,
          updatedAt: now,
        })
        .where(eq(application.id, app.id));
    }

    // The snapshot: the answers exactly as submitted, kept on the append-only event.
    const snapshot = questions.map((q) => ({
      question_key: q.questionKey,
      question_version_id: q.questionVersionId,
      value: valueOf(stored.get(q.questionVersionId) ?? null, q.type),
    }));

    let submittedAt: Date;
    try {
      const result = await transition(tx, {
        action: "submit",
        applicationId: app.id,
        actor: APPLICANT_ACTOR,
        metadata: { submission: { form_version_id: app.formVersionId, answers: snapshot } },
        now,
      });
      submittedAt = result.event.occurredAt;
    } catch (error) {
      if (error instanceof TransitionError && error.code === "already_submitted") {
        throw new AnswersError("already_submitted", "This application was already sent");
      }
      if (error instanceof TransitionError && error.code === "application_closed") {
        throw new AnswersError("application_not_open", "This application is closed");
      }
      throw error;
    }

    const queued: string[] = [];
    try {
      const { messageId } = await queueMessage(tx, {
        employerId: input.employerId,
        channel: "email",
        personId: app.personId,
        applicationId: app.id,
        content: { purpose: "submit_confirmation" },
        dedupeKey: `submit_confirmation:${app.id}`,
        triggeredBy: APPLICANT_ACTOR,
        now,
      });
      queued.push(messageId);
    } catch (error) {
      // A person with no email on file still submits; staff see the gap on the profile.
      if (!(error instanceof SendError && error.code === "no_address")) throw error;
    }
    return { applicationId: app.id, submittedAt, queued };
  });
}

// ---------------------------------------------------------------------------
// Values

// The typed column an answer lives in, validated for the question's type and rules.
export function columnsFor(q: Pick<FormQuestion, "type" | "options" | "validation">, raw: AnswerValue): ValueColumns {
  const empty: ValueColumns = { valueText: null, valueNumber: null, valueDate: null, valueBool: null, valueOptions: null };
  const rules = q.validation ?? {};
  switch (q.type) {
    case "short_text":
    case "long_text": {
      const text = parse(z.string().max(rules.maxLength ?? (q.type === "short_text" ? 200 : 2000)).nullable(), raw);
      const trimmed = text?.trim() ?? "";
      return { ...empty, valueText: trimmed === "" ? null : trimmed };
    }
    case "number": {
      let schema = z.number().finite();
      if (rules.integer) schema = schema.int();
      if (rules.min !== undefined) schema = schema.min(rules.min);
      if (rules.max !== undefined) schema = schema.max(rules.max);
      const n = parse(schema.nullable(), raw === "" ? null : raw);
      return { ...empty, valueNumber: n === null ? null : String(n) };
    }
    case "date": {
      const date = parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), raw === "" ? null : raw);
      if (date !== null && Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        throw new AnswersError("invalid_value", "That is not a real date");
      }
      return { ...empty, valueDate: date };
    }
    case "yes_no": {
      const bool = parse(z.boolean().nullable(), raw === "" ? null : raw);
      return { ...empty, valueBool: bool };
    }
    case "single_choice":
    case "multi_choice": {
      const keys = new Set((q.options ?? []).map((o) => o.key));
      const picked = parse(z.array(z.string()).nullable(), raw === "" ? null : typeof raw === "string" ? [raw] : raw) ?? [];
      const unique = [...new Set(picked)];
      if (unique.some((key) => !keys.has(key))) throw new AnswersError("invalid_value", "That is not one of the choices");
      if (q.type === "single_choice" && unique.length > 1) throw new AnswersError("invalid_value", "Pick one");
      return { ...empty, valueOptions: unique.length === 0 ? null : unique };
    }
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AnswersError("invalid_value", result.error.issues[0]?.message ?? "Invalid value");
  return result.data;
}

// The plain value the client works with, read back from the typed columns.
export function valueOf(row: AnswerRow | null, type: QuestionType): AnswerValue {
  if (!row) return null;
  switch (type) {
    case "short_text":
    case "long_text":
      return row.valueText;
    case "number":
      return row.valueNumber === null ? null : Number(row.valueNumber);
    case "date":
      return row.valueDate;
    case "yes_no":
      return row.valueBool;
    case "single_choice":
    case "multi_choice":
      return row.valueOptions;
  }
}

export function isEmpty(value: AnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Lookups

async function loadOpenApplication(tx: Tx, applicationId: string) {
  const [app] = await tx.select().from(application).where(eq(application.id, applicationId));
  if (!app || app.deletedAt) throw new AnswersError("application_not_found", "No such application");
  if (app.answersLocked || app.submittedAt) throw new AnswersError("answers_locked", "This application was already sent");
  if (app.status !== "open") throw new AnswersError("application_not_open", "This application is closed");
  return app;
}

// An answer belongs to a question version that is an item of the application's pinned form.
async function questionInForm(tx: Tx, formVersionId: string, questionVersionId: string): Promise<FormQuestion> {
  const [row] = await tx
    .select({
      questionVersionId: formItem.questionVersionId,
      questionKey: question.key,
      sectionKey: formItem.sectionKey,
      sortOrder: formItem.sortOrder,
      required: formItem.required,
      type: questionVersion.type,
      prompt: questionVersion.prompt,
      help: questionVersion.help,
      options: questionVersion.options,
      validation: questionVersion.validation,
    })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(formItem.formVersionId, formVersionId), eq(formItem.questionVersionId, questionVersionId)));
  if (!row) throw new AnswersError("question_not_in_form", "That question is not on this form");
  return row;
}
