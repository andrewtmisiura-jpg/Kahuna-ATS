import { z } from "zod";
import type { Db } from "@/db";
import { job, type JobPayload } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

// The kinds of job the runner knows and what each carries (DATA_MODEL.md, job: the kind
// is "validated in code, so new kinds need no migration"; the payload is "ids only, never
// PII"). The runner claims only kinds it knows, so a job a newer build queued during a
// deploy waits for that build instead of failing on an older one.

export const JOB_PAYLOADS = {
  // Score one application against one rubric version. requested_by_user_id names the
  // Admin who asked for a re-score; without it the system queued the job.
  score_application: z.object({
    application_id: z.uuid(),
    rubric_version_id: z.uuid(),
    requested_by_user_id: z.uuid().optional(),
  }),
} as const;

export type JobKind = keyof typeof JOB_PAYLOADS;
export const JOB_KINDS = Object.keys(JOB_PAYLOADS) as JobKind[];
export type JobPayloadOf<K extends JobKind> = z.infer<(typeof JOB_PAYLOADS)[K]>;

export type NewJob = { [K in JobKind]: { kind: K; payload: JobPayloadOf<K>; runAt: Date; dedupeKey?: string | null } }[JobKind];

// One insert per 500 jobs keeps a large re-score well under the statement's parameter limit.
const BATCH = 500;

// Queues jobs, skipping any whose dedupe key is taken: a finished job keeps its key, so
// the same key never runs twice. Returns the ids of the jobs actually queued.
export async function enqueueJobs(db: Db, jobs: readonly NewJob[], now: Date = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < jobs.length; start += BATCH) {
    const rows = jobs.slice(start, start + BATCH).map((next) => ({
      id: uuidv7(),
      kind: next.kind,
      payload: JOB_PAYLOADS[next.kind].parse(next.payload) as JobPayload,
      runAt: next.runAt,
      dedupeKey: next.dedupeKey ?? null,
      createdAt: now,
    }));
    const inserted = await db.insert(job).values(rows).onConflictDoNothing({ target: job.dedupeKey }).returning({ id: job.id });
    ids.push(...inserted.map((row) => row.id));
  }
  return ids;
}
