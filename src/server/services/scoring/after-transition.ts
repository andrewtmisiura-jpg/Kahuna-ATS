import { and, eq } from "drizzle-orm";
import { aiScore, MILESTONES, pipelineStage, reviewDecision, rubric, type Milestone, type ReviewDecisionValue } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { AfterTransitionContext, Tx } from "../applications/after-transition";
import { effectiveEvents } from "../applications/replay";
import { queueScoreForSubmission } from "./jobs";

// Scoring's part of every transition, in the transition's own transaction (DATA_MODEL.md,
// review_decision and job).
//   A submitted event queues a score job when the role's rubric is hidden or visible
//   and has a published version; the next cron pass runs it.
//   The screening decision, compared with the AI later: for an application with a
//   current score that has not reached interview_invited, a staff disqualification
//   writes decline with the same reason, a move to a stage at or after
//   interview_invited (Hire now and board drags included) writes advance, and setting
//   Hold writes hold. A move into Reviewed, a not_selected or withdrew closure, and
//   anything after interview_invited was reached write nothing, so a later ladder-test
//   failure never reads as the reviewer overruling the score.

const INTERVIEW_INVITED = MILESTONES.indexOf("interview_invited");

function atOrAfterInterview(milestone: Milestone | null | undefined): boolean {
  return Boolean(milestone) && MILESTONES.indexOf(milestone!) >= INTERVIEW_INVITED;
}

export async function scoringAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {
  const { event, after, now } = context;
  if (event.kind === "submitted") {
    await queueScoreForSubmission(tx, { applicationId: after.id, roleId: after.roleId, now });
    return;
  }

  const decision = screeningDecision(context);
  if (!decision) return;
  const [current] = await tx
    .select({ id: aiScore.id, status: aiScore.status, hiddenFromReviewers: aiScore.hiddenFromReviewers })
    .from(aiScore)
    .where(and(eq(aiScore.applicationId, after.id), eq(aiScore.isCurrent, true)));
  if (!current) return;
  if (await reachedInterviewInvited(tx, context)) return;

  // Visible means the reviewer could have seen the number: the role shows scores, this
  // score was not made hidden, and it is a number at all.
  const [mode] = await tx.select({ scoringMode: rubric.scoringMode }).from(rubric).where(eq(rubric.roleId, after.roleId));
  await tx.insert(reviewDecision).values({
    id: uuidv7(),
    applicationId: after.id,
    decision: decision.decision,
    reasonOptionId: decision.reasonOptionId,
    note: event.note,
    aiScoreId: current.id,
    aiScoreVisible: mode?.scoringMode === "visible" && !current.hiddenFromReviewers && current.status === "succeeded",
    applicationEventId: event.id,
    decidedBy: decision.decidedBy,
    decidedAt: event.occurredAt,
  });
}

type ScreeningDecision = { decision: ReviewDecisionValue; reasonOptionId: string | null; decidedBy: string };

// The decision this event records, before checking the score and the history. Only a
// staff member decides.
export function screeningDecision(context: Pick<AfterTransitionContext, "event" | "toStage">): ScreeningDecision | null {
  const { event, toStage } = context;
  if (event.actorType !== "staff" || !event.actorUserId) return null;
  const decidedBy = event.actorUserId;
  switch (event.kind) {
    case "closed":
      return event.closedOutcome === "disqualified" ? { decision: "decline", reasonOptionId: event.reasonOptionId, decidedBy } : null;
    case "hold_set":
      return { decision: "hold", reasonOptionId: null, decidedBy };
    case "stage_changed":
    case "reopened":
      return atOrAfterInterview(toStage?.milestone) ? { decision: "advance", reasonOptionId: null, decidedBy } : null;
    default:
      return null;
  }
}

// Whether an earlier event that still counts (not voided) moved the application to a
// stage at or after interview_invited.
async function reachedInterviewInvited(tx: Tx, context: AfterTransitionContext): Promise<boolean> {
  const stages = await tx.select({ id: pipelineStage.id, milestone: pipelineStage.milestone }).from(pipelineStage).where(eq(pipelineStage.roleId, context.after.roleId));
  const milestones = new Map(stages.map((stage) => [stage.id, stage.milestone]));
  return effectiveEvents(context.earlierEvents).some((event) => event.toStageId !== null && atOrAfterInterview(milestones.get(event.toStageId)));
}
