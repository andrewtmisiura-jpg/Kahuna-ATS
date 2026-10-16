import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, smallint, text, unique } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import { jobStatusEnum } from "./enums";

// Ids and flags only, never PII.
export type JobPayload = Record<string, string | number | boolean | null>;

// Scheduled work beyond sending (DATA_MODEL.md, job): scoring and re-scoring, run one
// at a time by the cron's jobs step (src/server/services/jobs/run.ts), and later the
// Phase 3 purge. The kind is validated in code, so a new kind needs no migration.
export const job = pgTable(
  "job",
  {
    id: id(),
    kind: text().notNull(),
    payload: jsonb().$type<JobPayload>().notNull(),
    runAt: timestamptz().notNull(),
    status: jobStatusEnum().notNull().default("queued"),
    attempts: smallint().notNull().default(0),
    maxAttempts: smallint().notNull().default(5),
    lockedAt: timestamptz(),
    lockedBy: text(),
    // Provider errors can echo addresses.
    lastError: text(),
    // At most one job per key, e.g. one score per application and rubric version.
    dedupeKey: text(),
    finishedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("job_dedupe_key_unique").on(table.dedupeKey),
    index("job_run_at_due_idx").on(table.runAt).where(sql`status in ('queued', 'retry')`),
  ],
);
