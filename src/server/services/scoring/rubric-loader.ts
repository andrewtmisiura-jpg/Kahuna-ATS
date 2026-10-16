import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { question, questionVersion, rubricCriterion, rubricVersion, rubricVersionCriterion } from "@/db/schema";
import type { RubricForScoring } from "./types";

// One rubric version as a scorer reads it (types.ts), draft or published, so the rubric
// editor's "Try it" and the scoring job share it. Criteria come in sort order. Each
// question carries the newest published wording of its lineage, or the newest draft
// while none is published (a role whose form is still a draft). A lineage marked
// ai_never_send is left out even when the rubric names it, so turning the flag on after
// a rubric is published still keeps that question from the model. Null when there is no
// such version.
export async function loadRubricForScoring(db: Db, rubricVersionId: string): Promise<RubricForScoring | null> {
  const [version] = await db.select().from(rubricVersion).where(eq(rubricVersion.id, rubricVersionId));
  if (!version) return null;

  const criteria = await db
    .select({
      criterionId: rubricVersionCriterion.criterionId,
      key: rubricCriterion.key,
      name: rubricVersionCriterion.name,
      weight: rubricVersionCriterion.weight,
      guidanceStrong: rubricVersionCriterion.guidanceStrong,
      guidanceAcceptable: rubricVersionCriterion.guidanceAcceptable,
      guidanceWeak: rubricVersionCriterion.guidanceWeak,
      questionIds: rubricVersionCriterion.questionIds,
    })
    .from(rubricVersionCriterion)
    .innerJoin(rubricCriterion, eq(rubricCriterion.id, rubricVersionCriterion.criterionId))
    .where(eq(rubricVersionCriterion.rubricVersionId, rubricVersionId))
    .orderBy(asc(rubricVersionCriterion.sortOrder));

  const questionIds = [...new Set(criteria.flatMap((criterion) => criterion.questionIds))];
  const lineages =
    questionIds.length === 0
      ? []
      : await db
          .select({ id: question.id, key: question.key, aiNeverSend: question.aiNeverSend })
          .from(question)
          .where(inArray(question.id, questionIds));
  const versions =
    questionIds.length === 0
      ? []
      : await db
          .select({ questionId: questionVersion.questionId, prompt: questionVersion.prompt, publishedAt: questionVersion.publishedAt })
          .from(questionVersion)
          .where(inArray(questionVersion.questionId, questionIds))
          .orderBy(desc(questionVersion.version));
  const prompts = new Map<string, string>();
  for (const v of versions) if (v.publishedAt && !prompts.has(v.questionId)) prompts.set(v.questionId, v.prompt);
  for (const v of versions) if (!prompts.has(v.questionId)) prompts.set(v.questionId, v.prompt);
  const sendable = new Map(lineages.filter((lineage) => !lineage.aiNeverSend).map((lineage) => [lineage.id, lineage.key]));

  return {
    rubricVersionId: version.id,
    instructions: version.instructions,
    allowedFlags: version.allowedFlags,
    criteria: criteria.map(({ questionIds: ids, ...criterion }) => ({
      ...criterion,
      questions: ids.flatMap((questionId) => {
        const key = sendable.get(questionId);
        const prompt = prompts.get(questionId);
        return key === undefined || prompt === undefined ? [] : [{ questionId, key, prompt }];
      }),
    })),
  };
}
