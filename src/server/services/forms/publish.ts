import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { formItem, formVersion, question, questionVersion } from "@/db/schema";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";
import { FormEditorError } from "./editor";

// Publishing a draft (DATA_MODEL.md, form_version): one transaction that stamps
// published_at on every question version in the draft that lacks one, retires
// the role's current published version, and flips the draft to published with
// the written change reason. After that the database triggers freeze the form,
// its items and those question versions. Applications already started keep the
// version they pinned; only new applications pick up the new one.

export type DraftProblem =
  | { code: "empty_form"; message: string }
  | { code: "section_not_found"; message: string; sectionKey: string; key: string }
  | { code: "duplicate_lineage"; message: string; key: string }
  | { code: "question_wrong_role"; message: string; key: string }
  | { code: "options_required"; message: string; key: string };

// Blocking problems a draft has, in the order they should be fixed. Empty when
// the draft can be published.
export async function checkDraft(db: Db, formVersionId: string): Promise<DraftProblem[]> {
  const [form] = await db.select().from(formVersion).where(eq(formVersion.id, formVersionId));
  if (!form) throw new FormEditorError("form_not_found", "That form version no longer exists");
  const items = await db
    .select({
      questionVersionId: formItem.questionVersionId,
      sectionKey: formItem.sectionKey,
      key: question.key,
      questionId: question.id,
      roleId: question.roleId,
      type: questionVersion.type,
      options: questionVersion.options,
    })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(eq(formItem.formVersionId, form.id));

  const problems: DraftProblem[] = [];
  if (items.length === 0) problems.push({ code: "empty_form", message: "Add at least one question before publishing" });
  const sectionKeys = new Set(form.sections.map((section) => section.key));
  const seenLineages = new Set<string>();
  for (const item of items) {
    if (!sectionKeys.has(item.sectionKey)) {
      problems.push({
        code: "section_not_found",
        message: `"${item.key}" sits in a section that no longer exists`,
        sectionKey: item.sectionKey,
        key: item.key,
      });
    }
    if (item.roleId !== form.roleId) {
      problems.push({ code: "question_wrong_role", message: `"${item.key}" belongs to another role`, key: item.key });
    }
    if (seenLineages.has(item.questionId)) {
      problems.push({ code: "duplicate_lineage", message: `"${item.key}" appears twice`, key: item.key });
    }
    seenLineages.add(item.questionId);
    if ((item.type === "single_choice" || item.type === "multi_choice") && (item.options?.length ?? 0) < 2) {
      problems.push({ code: "options_required", message: `"${item.key}" needs at least two choices`, key: item.key });
    }
  }
  return problems;
}

export type PublishInput = {
  formVersionId: string;
  // Required: a written, job-related reason for the change.
  changeReason: string;
  actor: Actor;
  now?: Date;
};

export type PublishResult = {
  formVersionId: string;
  version: number;
  previous: { formVersionId: string; version: number } | null;
  // Question versions that got published_at in this publish.
  questionVersionsPublished: number;
};

export async function publishForm(db: Db, input: PublishInput): Promise<PublishResult> {
  const changeReason = input.changeReason.trim();
  if (!changeReason) throw new FormEditorError("change_reason_required", "Write the reason for this change before publishing");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(formVersion).where(eq(formVersion.id, input.formVersionId)).for("update");
    if (!draft) throw new FormEditorError("form_not_found", "That form version no longer exists");
    if (draft.status !== "draft") {
      throw new FormEditorError("form_not_draft", `Form version ${draft.version} is already ${draft.status}`, { status: draft.status });
    }

    const problems = await checkDraft(tx, draft.id);
    if (problems.length > 0) {
      const first = problems[0]!;
      throw new FormEditorError(first.code, first.message, { problems });
    }

    // 1. Question versions in the draft that have never been published get their stamp.
    const unpublished = await tx
      .select({ id: questionVersion.id })
      .from(formItem)
      .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
      .where(and(eq(formItem.formVersionId, draft.id), isNull(questionVersion.publishedAt)));
    for (const row of unpublished) {
      await tx.update(questionVersion).set({ publishedAt: now }).where(eq(questionVersion.id, row.id));
    }

    // 2. Retire the current published form (the partial unique allows one per role).
    const [previous] = await tx
      .select({ id: formVersion.id, version: formVersion.version })
      .from(formVersion)
      .where(and(eq(formVersion.roleId, draft.roleId), eq(formVersion.status, "published")))
      .for("update");
    if (previous) {
      await tx.update(formVersion).set({ status: "retired" }).where(eq(formVersion.id, previous.id));
    }

    // 3. The draft becomes the live form.
    await tx
      .update(formVersion)
      .set({
        status: "published",
        changeReason,
        publishedAt: now,
        publishedBy: input.actor.type === "staff" ? input.actor.userId : null,
      })
      .where(eq(formVersion.id, draft.id));

    await writeAudit(tx, {
      actor: input.actor,
      action: "config.publish",
      entityType: "form_version",
      entityId: draft.id,
      occurredAt: now,
      changes: {
        roleId: draft.roleId,
        version: draft.version,
        previousVersion: previous?.version ?? null,
        previousFormVersionId: previous?.id ?? null,
        changeReason,
        questionVersionsPublished: unpublished.length,
      },
    });

    return {
      formVersionId: draft.id,
      version: draft.version,
      previous: previous ? { formVersionId: previous.id, version: previous.version } : null,
      questionVersionsPublished: unpublished.length,
    };
  });
}
