import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { aiCriterionScore, aiScore, application, person, rubricCriterion, rubricVersion, rubricVersionCriterion, type AiScoreStatus } from "@/db/schema";
import { liveRubric, pendingScoreJob } from "./jobs";
import { loadSnapshotSource } from "./score-application";
import { buildApplicationSnapshot, NeverSendLineageError } from "./snapshot";

// What the profile's AI score panel shows (DATA_MODEL.md, ai_score: "The profile shows the
// number with the per-criterion scores, the rationale and the rubric version beside it").
// Only for a submitted application in a role whose rubric is in visible mode: hidden mode
// shows the score nowhere outside Settings > AI scoring, so the panel gets nothing then.

export type ScoringPanelScore = {
  id: string;
  status: AiScoreStatus;
  // Set only when the score succeeded.
  overallScore: number | null;
  // Made while the role's scores were hidden, so it is never shown.
  hiddenFromReviewers: boolean;
  rationale: string | null;
  error: string | null;
  flags: { key: string; label: string }[];
  keywordHits: string[];
  rubricVersion: number;
  completedAt: Date | null;
  criteria: { key: string; name: string; score: number; rationale: string | null }[];
};

export type ScoringPanelData = {
  // The role's published rubric version, null while none is.
  publishedVersion: number | null;
  current: ScoringPanelScore | null;
  // A score job for this application is waiting or running.
  pending: boolean;
  // The published version reads questions this application has no answers to, so it is not scored against it.
  missingAnswers: boolean;
  // The published version reads a question marked never to send to the AI, so nothing is scored until it is fixed.
  readsNeverSend: boolean;
};

export async function loadScoringPanel(db: Db, applicationId: string): Promise<ScoringPanelData | null> {
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
    .where(eq(application.id, applicationId));
  if (!app || app.deletedAt || !app.submittedAt) return null;
  const live = await liveRubric(db, app.roleId);
  if (live?.mode !== "visible") return null;

  const [current, pending] = await Promise.all([loadCurrentScore(db, app.id), pendingScoreJob(db, app.id)]);
  let missingAnswers = false;
  let readsNeverSend = false;
  if (live.versionId) {
    const source = await loadSnapshotSource(db, {
      rubricVersionId: live.versionId,
      applicationId: app.id,
      formVersionId: app.formVersionId,
      names: [app.firstName, app.lastName],
    });
    try {
      missingAnswers = buildApplicationSnapshot(source).missingCriteria.length > 0;
    } catch (error) {
      if (!(error instanceof NeverSendLineageError)) throw error;
      readsNeverSend = true;
    }
  }
  return { publishedVersion: live.version, current, pending, missingAnswers, readsNeverSend };
}

async function loadCurrentScore(db: Db, applicationId: string): Promise<ScoringPanelScore | null> {
  const [row] = await db
    .select({ score: aiScore, version: rubricVersion.version, allowedFlags: rubricVersion.allowedFlags })
    .from(aiScore)
    .innerJoin(rubricVersion, eq(rubricVersion.id, aiScore.rubricVersionId))
    .where(and(eq(aiScore.applicationId, applicationId), eq(aiScore.isCurrent, true)));
  if (!row) return null;
  const { score } = row;
  const criteria = await db
    .select({ key: rubricCriterion.key, name: rubricVersionCriterion.name, score: aiCriterionScore.score, rationale: aiCriterionScore.rationale })
    .from(aiCriterionScore)
    .innerJoin(rubricCriterion, eq(rubricCriterion.id, aiCriterionScore.criterionId))
    .innerJoin(
      rubricVersionCriterion,
      and(eq(rubricVersionCriterion.criterionId, aiCriterionScore.criterionId), eq(rubricVersionCriterion.rubricVersionId, score.rubricVersionId)),
    )
    .where(eq(aiCriterionScore.aiScoreId, score.id))
    .orderBy(asc(rubricVersionCriterion.sortOrder));
  const labels = new Map(row.allowedFlags.map((flag) => [flag.key, flag.label]));
  return {
    id: score.id,
    status: score.status,
    overallScore: score.overallScore,
    hiddenFromReviewers: score.hiddenFromReviewers,
    rationale: score.rationale,
    error: score.error,
    flags: (score.flags ?? []).map((key) => ({ key, label: labels.get(key) ?? key })),
    keywordHits: score.keywordHits ?? [],
    rubricVersion: row.version,
    completedAt: score.completedAt,
    criteria,
  };
}
