import type { Db } from "@/db";

export type RescoreRequest = { roleId: string; actorUserId: string };
export type RescoreResult = { queued: number };

// Queues a re-score of a role's scored applications against its live rubric version, one
// job per application, which the cron's jobs step runs one at a time (DATA_MODEL.md, ai_score:
// "Re-scoring runs sequentially through the job table"). A version that changes only
// weights can recompute from the stored criterion grades without a model call. Queues
// nothing until the scoring build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the scoring build fills in
export async function enqueueRescore(db: Db, request: RescoreRequest): Promise<RescoreResult> {
  return { queued: 0 };
}
