import type { AfterTransitionContext, Tx } from "../applications/after-transition";

// Scoring's part of every transition (DATA_MODEL.md, review_decision and job). For an
// application with a current score that has not reached interview_invited: a staff
// disqualification writes decline with the same reason, a move to a stage at or after
// interview_invited writes advance, and a Hold writes hold; not_selected and withdrew
// closures and a move into Reviewed write nothing. A submitted event queues a score job
// when the role's rubric is hidden or visible and has a published version. Writes
// nothing until the scoring build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the scoring build fills in
export async function scoringAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {}
