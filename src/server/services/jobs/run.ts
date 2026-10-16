import type { Db } from "@/db";
import type { Providers } from "../messaging/providers/types";
import type { Scorer } from "../scoring/types";

export type RunJobsOptions = {
  now: Date;
  // For the alert when a job dies.
  providers: Providers;
  // Claim no new job once this long has passed, so a pass ends before the next one starts.
  timeBudgetMs: number;
  // Defaults to getScorer(); tests pass the fake or one that fails on purpose.
  scorer?: Scorer;
};

export type JobsSummary = {
  claimed: number;
  succeeded: number;
  // Failed this time and queued again with a backoff.
  retried: number;
  // Out of attempts, alerted.
  dead: number;
  // Scoring jobs left for the next Central day because the employer's scoring_daily_cap was reached.
  deferredByCap: number;
};

// The cron's jobs step (DATA_MODEL.md, job): claims due queued and retry rows one at a
// time with FOR UPDATE SKIP LOCKED, so overlapping passes never run a job twice, runs
// each by its kind, retries a failure with a backoff up to max_attempts and marks the
// rest dead with an alert. Scoring stops at the employer's scoring_daily_cap. Runs
// nothing until the scoring build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the scoring build fills in
export async function runDueJobs(db: Db, options: RunJobsOptions): Promise<JobsSummary> {
  return { claimed: 0, succeeded: 0, retried: 0, dead: 0, deferredByCap: 0 };
}
