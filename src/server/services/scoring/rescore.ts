import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "../actor";
import { writeAudit } from "../audit";
import { enqueueJobs } from "../jobs/queue";
import { rescoreDedupeKey, SCORE_JOB, scorableVersion, scoreJob } from "./jobs";

export type RescoreRequest = { roleId: string; actorUserId: string };
export type RescoreResult = { queued: number };

// Queues a re-score of every submitted application of a role (open, hired or closed)
// against its published rubric version, one job per application, which the cron's jobs
// step runs one at a time under the daily cap (DATA_MODEL.md, ai_score: "Re-scoring runs
// sequentially through the job table"). An application with a score job for that version
// still waiting is left alone. Each new score becomes the current one when it lands.
// Throws ScoringRequestError when the role has no published rubric or scoring is off.
// Audited as one row for the role.
export async function enqueueRescore(db: Db, request: RescoreRequest): Promise<RescoreResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const versionId = await scorableVersion(tx, request.roleId);
    const rows = await tx
      .select({ id: application.id })
      .from(application)
      .where(
        and(
          eq(application.roleId, request.roleId),
          isNotNull(application.submittedAt),
          isNull(application.deletedAt),
          sql`not exists (
            select 1 from job j where j.kind = ${SCORE_JOB} and j.status in ('queued', 'retry', 'running')
              and j.payload->>'application_id' = ${application.id}::text and j.payload->>'rubric_version_id' = ${versionId})`,
        ),
      );
    const batchId = uuidv7();
    const queued = await enqueueJobs(
      tx,
      rows.map((row) => scoreJob(row.id, versionId, now, rescoreDedupeKey(row.id, versionId, batchId), request.actorUserId)),
      now,
    );
    await writeAudit(tx, {
      actor: staffActor(request.actorUserId),
      action: "ai_score.rescore_role",
      entityType: "role",
      entityId: request.roleId,
      changes: { rubric_version_id: versionId, queued: queued.length },
      occurredAt: now,
    });
    return { queued: queued.length };
  });
}
