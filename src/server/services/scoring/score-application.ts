import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import {
  aiCriterionScore,
  aiScore,
  answer,
  application,
  formItem,
  person,
  question,
  questionVersion,
  reviewDecision,
  rubric,
  rubricCriterion,
  rubricVersionCriterion,
  type AiScoreStatus,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { actorColumns, type Actor } from "../actor";
import { formatAnswer } from "../applications/queries";
import type { Providers } from "../messaging/providers/types";
import { notifyAdmin } from "../notify";
import { scoreWithRubric } from "./engine";
import { liveRubric } from "./jobs";
import { findProtectedTraitWords } from "./keywords";
import { loadRubricForScoring } from "./rubric-loader";
import { buildApplicationSnapshot, type SnapshotSource } from "./snapshot";
import type { Scorer } from "./types";

// Scoring one application, the work of one score_application job (DATA_MODEL.md, ai_score
// and ai_criterion_score). It reads the role's published rubric version and the answers
// it asks for, sends the anonymous snapshot to the scorer, and writes the score with its
// criterion grades in one transaction as the application's current score. It writes
// nothing else: no event, no message to the applicant, no stage or status change. The AI
// never moves, rejects or messages anyone.

export type ScoreApplicationInput = {
  applicationId: string;
  rubricVersionId: string;
  // Staff for an Admin's re-score, otherwise the system.
  requestedBy: Actor;
  scorer: Scorer;
  now?: Date;
  // For the alert when a rationale names a protected trait.
  providers?: Providers;
};

export type ScoreSkipReason =
  | "application_gone"
  | "not_submitted"
  // Scoring was turned off for the role after the job was queued.
  | "scoring_off"
  // Another version was published after the job was queued; it gets its own job.
  | "superseded"
  // A criterion has no answer to read (snow applications on form v1). Nothing is sent and no score row is written.
  | "missing_answers";

export type ScoreOutcome =
  | { kind: "scored"; aiScoreId: string; status: AiScoreStatus; overallScore: number | null; keywordHits: string[] }
  | { kind: "skipped"; reason: ScoreSkipReason };

export async function scoreApplication(db: Db, input: ScoreApplicationInput): Promise<ScoreOutcome> {
  const now = input.now ?? new Date();
  const skipped = (reason: ScoreSkipReason): ScoreOutcome => ({ kind: "skipped", reason });

  const [app] = await db
    .select({
      id: application.id,
      roleId: application.roleId,
      formVersionId: application.formVersionId,
      submittedAt: application.submittedAt,
      deletedAt: application.deletedAt,
      firstName: person.firstName,
      lastName: person.lastName,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .where(eq(application.id, input.applicationId));
  if (!app || app.deletedAt) return skipped("application_gone");
  if (!app.submittedAt) return skipped("not_submitted");
  const live = await liveRubric(db, app.roleId);
  if (!live || live.mode === "off") return skipped("scoring_off");
  if (live.versionId !== input.rubricVersionId) return skipped("superseded");
  const scoringRubric = await loadRubricForScoring(db, input.rubricVersionId);
  if (!scoringRubric) return skipped("superseded");

  const source = await loadSnapshotSource(db, {
    rubricVersionId: input.rubricVersionId,
    applicationId: app.id,
    formVersionId: app.formVersionId,
    names: [app.firstName, app.lastName],
  });
  // Throws when the rubric reads a never-send question, so nothing is sent; the job
  // retries and then alerts.
  const snapshot = buildApplicationSnapshot(source);
  if (snapshot.missingCriteria.length > 0) return skipped("missing_answers");

  // A scorer's throw (a timeout, a 5xx) goes up to the job runner, which retries.
  const result = await scoreWithRubric(scoringRubric, snapshot.input, input.scorer);
  const succeeded = result.status === "succeeded" ? result : null;
  const keywordHits = succeeded ? findProtectedTraitWords([succeeded.overallRationale, ...succeeded.criteria.map((c) => c.rationale)]) : [];
  const criterionIds = new Map(scoringRubric.criteria.map((criterion) => [criterion.key, criterion.criterionId]));
  const requested = actorColumns(input.requestedBy);

  const aiScoreId = await db.transaction(async (tx) => {
    // The application row lock orders this write with a transition reading the current
    // score for its review decision.
    const [locked] = await tx.select({ status: application.status }).from(application).where(eq(application.id, app.id)).for("update");
    const [mode] = await tx.select({ scoringMode: rubric.scoringMode }).from(rubric).where(eq(rubric.id, live.rubricId));
    const [decided] = await tx.select({ id: reviewDecision.id }).from(reviewDecision).where(eq(reviewDecision.applicationId, app.id)).limit(1);

    const id = uuidv7();
    await tx.update(aiScore).set({ isCurrent: false }).where(and(eq(aiScore.applicationId, app.id), eq(aiScore.isCurrent, true)));
    await tx.insert(aiScore).values({
      id,
      applicationId: app.id,
      rubricVersionId: input.rubricVersionId,
      modelId: result.modelId,
      promptVersion: result.promptVersion,
      status: result.status,
      // Exactly what the scorer was sent.
      inputSnapshot: snapshot.input,
      rawOutput: result.rawOutput ?? null,
      overallScore: succeeded?.overallScore ?? null,
      rationale: succeeded?.overallRationale ?? null,
      flags: succeeded ? succeeded.flags : null,
      keywordHits: succeeded ? keywordHits : null,
      isCurrent: true,
      // Hidden mode: the score shows nowhere but Settings > AI scoring, now or later.
      hiddenFromReviewers: mode?.scoringMode !== "visible",
      // Left out of the agreement report: a person had already decided.
      scoredAfterDecision: Boolean(decided) || locked?.status === "closed" || locked?.status === "hired",
      requestedByType: requested.actorType,
      requestedByUserId: requested.actorUserId,
      inputTokens: succeeded?.inputTokens ?? null,
      outputTokens: succeeded?.outputTokens ?? null,
      error: result.status === "succeeded" ? null : result.error,
      completedAt: now,
      createdAt: now,
    });
    if (succeeded) {
      await tx.insert(aiCriterionScore).values(
        succeeded.criteria.map((criterion) => {
          // The rubric version's own criteria, so the id is always one of the version's.
          const criterionId = criterionIds.get(criterion.criterionKey);
          if (!criterionId) throw new Error(`Criterion ${criterion.criterionKey} is not in rubric version ${input.rubricVersionId}`);
          return { aiScoreId: id, criterionId, score: criterion.score, rationale: criterion.rationale };
        }),
      );
    }
    return id;
  });

  if (keywordHits.length > 0) {
    await notifyAdmin(
      db,
      `keyword_hits:${aiScoreId}`,
      "An AI score's rationale names a protected trait",
      `Score ${aiScoreId} on application ${app.id} mentions: ${keywordHits.join(", ")}. Read the rationale on the profile; the score is kept as it is.`,
      { providers: input.providers, now },
    );
  }
  return { kind: "scored", aiScoreId, status: result.status, overallScore: succeeded?.overallScore ?? null, keywordHits };
}

// What buildApplicationSnapshot needs for one application and rubric version: the
// version's criteria with the lineages they read, those lineages' never-send flags, and
// the application's answers to them on its pinned form, as staff read them (choices as
// labels), with the wording of the question version the applicant saw.
export async function loadSnapshotSource(
  db: Db,
  input: { rubricVersionId: string; applicationId: string; formVersionId: string; names: (string | null)[] },
): Promise<SnapshotSource> {
  const criteria = await db
    .select({ criterionKey: rubricCriterion.key, questionIds: rubricVersionCriterion.questionIds })
    .from(rubricVersionCriterion)
    .innerJoin(rubricCriterion, eq(rubricCriterion.id, rubricVersionCriterion.criterionId))
    .where(eq(rubricVersionCriterion.rubricVersionId, input.rubricVersionId))
    .orderBy(asc(rubricVersionCriterion.sortOrder));
  const questionIds = [...new Set(criteria.flatMap((criterion) => criterion.questionIds))];
  if (questionIds.length === 0) return { criteria, lineages: [], answers: [], names: input.names };

  const [lineages, rows] = await Promise.all([
    db
      .select({ questionId: question.id, key: question.key, aiNeverSend: question.aiNeverSend })
      .from(question)
      .where(inArray(question.id, questionIds)),
    db
      .select({ questionId: questionVersion.questionId, prompt: questionVersion.prompt, type: questionVersion.type, options: questionVersion.options, answer })
      .from(formItem)
      .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
      .leftJoin(answer, and(eq(answer.questionVersionId, formItem.questionVersionId), eq(answer.applicationId, input.applicationId)))
      .where(and(eq(formItem.formVersionId, input.formVersionId), inArray(questionVersion.questionId, questionIds))),
  ]);
  return {
    criteria,
    lineages,
    answers: rows.map((row) => ({ questionId: row.questionId, prompt: row.prompt, text: formatAnswer(row.answer, row) })),
    names: input.names,
  };
}
