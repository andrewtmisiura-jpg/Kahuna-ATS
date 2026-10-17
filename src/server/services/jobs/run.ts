import { hostname } from "node:os";
import { and, asc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { job } from "@/db/schema";
import { staffActor, SYSTEM_ACTOR } from "../actor";
import type { Providers } from "../messaging/providers/types";
import { notifyAdmin } from "../notify";
import { ScorerError } from "../scoring/errors";
import { capAlertKind, capAlertSent, queueMissingScores, SCORE_JOB, scoringCapFor } from "../scoring/jobs";
import { getScorer } from "../scoring/provider";
import { scoreApplication } from "../scoring/score-application";
import type { Scorer } from "../scoring/types";
import { JOB_KINDS, JOB_PAYLOADS, type JobKind } from "./queue";

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

// The cron's jobs step (DATA_MODEL.md, job). First it puts back jobs stuck in running and
// sweeps for applications that need a score; then it claims one due job at a time
// (queued or retry, run_at reached) with FOR UPDATE SKIP LOCKED, so overlapping passes
// never run a job twice, marks it running, and runs it by its kind. A failure is retried
// after 2, 4, 8, ... minutes (at most 60) until max_attempts, then the job is dead and
// alerted. A failed scoring call ends scoring for the pass, so an outage costs one
// attempt a pass rather than one for every queued score; a refusal a retry will not fix
// (no key, a key or model the API refuses) costs none. A scoring job over the employer's
// daily cap waits for the next Central day. No job is claimed once timeBudgetMs has passed.

// A job still running after this long was cut off (a crash, a deploy) and goes back to retry.
export const STUCK_AFTER_MS = 15 * 60_000;
const MAX_BACKOFF_MINUTES = 60;
// A job the API refused waits this long, without spending an attempt, so a refusal that
// only this application's request gets cannot hold up the rest of the queue.
const REFUSED_WAIT_MS = 60 * 60_000;
const ERROR_MAX_LENGTH = 500;

type JobRow = typeof job.$inferSelect;

// A job its runner can never finish, such as a payload of the wrong shape. Dead at once.
class PermanentJobError extends Error {}

export async function runDueJobs(db: Db, options: RunJobsOptions): Promise<JobsSummary> {
  const started = Date.now();
  // The pass's time plus however long the jobs have taken, so each job is stamped with
  // the time it ran while tests that pass a fixed now stay predictable.
  const clock = () => new Date(options.now.getTime() + (Date.now() - started));
  const summary: JobsSummary = { claimed: 0, succeeded: 0, retried: 0, dead: 0, deferredByCap: 0 };
  const worker = `${hostname()}:${process.pid}`;

  await reapStuckJobs(db, options, summary);
  await queueMissingScores(db, options.now);

  let scorer = options.scorer ?? null;
  // Set when a scoring call fails or cannot be made: no more scoring this pass, so an
  // outage or one bad setting never runs through the queue.
  let scoringPaused = false;
  const capsAlerted = new Set<string>();

  while (Date.now() - started < options.timeBudgetMs) {
    const kinds = scoringPaused ? JOB_KINDS.filter((kind) => kind !== SCORE_JOB) : JOB_KINDS;
    if (kinds.length === 0) break;
    const now = clock();
    const next = await claimNextJob(db, { now, worker, kinds });
    if (!next) break;

    if (next.outcome === "deferred") {
      summary.deferredByCap += 1;
      if (!capsAlerted.has(next.cap.employerId)) {
        capsAlerted.add(next.cap.employerId);
        await alertCapReached(db, next.cap, options.providers, now);
      }
      continue;
    }

    const claimed = next.job;
    if (claimed.kind === SCORE_JOB && !scorer) {
      try {
        scorer = getScorer();
      } catch (error) {
        // No key: put the job back as it was and wait for one, without spending an attempt.
        await releaseJob(db, next.before);
        scoringPaused = true;
        await alertScoringUnavailable(db, error, options.providers, now);
        continue;
      }
    }

    summary.claimed += 1;
    try {
      await runJob(db, claimed, { now, scorer, providers: options.providers });
      await db
        .update(job)
        .set({ status: "succeeded", finishedAt: clock(), lastError: null, lockedAt: null, lockedBy: null })
        .where(eq(job.id, claimed.id));
      summary.succeeded += 1;
    } catch (error) {
      const text = describeError(error);
      console.error(`[jobs] job ${claimed.id} (${claimed.kind}) attempt ${claimed.attempts} failed: ${text}`);
      if (error instanceof ScorerError && error.kind === "unavailable") {
        // Like a missing key: back as it was, without spending an attempt, until someone
        // fixes the key or the account.
        await releaseJob(db, next.before, { runAt: new Date(now.getTime() + REFUSED_WAIT_MS), lastError: text });
        summary.retried += 1;
        scoringPaused = true;
        await alertScoringUnavailable(db, error, options.providers, now);
        continue;
      }
      const dead = error instanceof PermanentJobError || claimed.attempts >= claimed.maxAttempts;
      await failJob(db, claimed, text, dead, clock());
      if (dead) {
        summary.dead += 1;
        await alertDead(db, claimed, text, options.providers, now);
      } else {
        summary.retried += 1;
      }
      if (error instanceof ScorerError) scoringPaused = true;
    }
  }
  return summary;
}

type ClaimResult =
  | { outcome: "claimed"; job: JobRow; before: JobRow }
  | { outcome: "deferred"; job: JobRow; cap: { employerId: string; date: string; cap: number } };

// A scoring job waits, unclaimed, while its role's scoring is off, so turning scoring
// off stops model calls at once and turning it back on picks the queue up again. The
// id is checked before the cast, so a malformed payload can never break the claim.
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const READY: Record<JobKind, SQL> = {
  score_application: sql`exists (
    select 1 from application a join rubric r on r.role_id = a.role_id
    where a.id = case when ${job.payload}->>'application_id' ~ ${UUID_PATTERN} then (${job.payload}->>'application_id')::uuid end
      and r.scoring_mode <> 'off')`,
};

// Claims the oldest due job of the given kinds: one row, locked with SKIP LOCKED and
// marked running with its attempt counted, in one short transaction, so the attempt is
// recorded even if the process dies while running it. A scoring job over its employer's
// daily cap is moved to the next Central day instead.
async function claimNextJob(db: Db, input: { now: Date; worker: string; kinds: readonly JobKind[] }): Promise<ClaimResult | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(job)
      .where(
        and(
          inArray(job.status, ["queued", "retry"]),
          lte(job.runAt, input.now),
          or(...input.kinds.map((kind) => and(eq(job.kind, kind), READY[kind]))),
        ),
      )
      .orderBy(asc(job.runAt), asc(job.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;

    if (row.kind === SCORE_JOB) {
      const applicationId = JOB_PAYLOADS.score_application.shape.application_id.parse(row.payload.application_id);
      const cap = await scoringCapFor(tx, applicationId, input.now);
      if (cap?.reached) {
        await tx.update(job).set({ runAt: cap.resumesAt }).where(eq(job.id, row.id));
        return { outcome: "deferred", job: row, cap: { employerId: cap.employerId, date: cap.date, cap: cap.cap } };
      }
    }

    const [claimed] = await tx
      .update(job)
      .set({ status: "running", attempts: sql`${job.attempts} + 1`, lockedAt: input.now, lockedBy: input.worker })
      .where(eq(job.id, row.id))
      .returning();
    return { outcome: "claimed", job: claimed!, before: row };
  });
}

async function runJob(db: Db, row: JobRow, context: { now: Date; scorer: Scorer | null; providers: Providers }): Promise<void> {
  switch (row.kind) {
    case SCORE_JOB: {
      const payload = JOB_PAYLOADS.score_application.safeParse(row.payload);
      if (!payload.success) throw new PermanentJobError(`Job ${row.id} has no application and rubric version ids`);
      await scoreApplication(db, {
        applicationId: payload.data.application_id,
        rubricVersionId: payload.data.rubric_version_id,
        requestedBy: payload.data.requested_by_user_id ? staffActor(payload.data.requested_by_user_id) : SYSTEM_ACTOR,
        scorer: context.scorer!,
        now: context.now,
        providers: context.providers,
      });
      return;
    }
    default:
      throw new PermanentJobError(`No runner for job kind ${row.kind}`);
  }
}

async function failJob(db: Db, row: JobRow, error: string, dead: boolean, now: Date) {
  const backoffMinutes = Math.min(2 ** row.attempts, MAX_BACKOFF_MINUTES);
  await db
    .update(job)
    .set(
      dead
        ? { status: "dead", finishedAt: now, lastError: error, lockedAt: null, lockedBy: null }
        : { status: "retry", runAt: new Date(now.getTime() + backoffMinutes * 60_000), lastError: error, lockedAt: null, lockedBy: null },
    )
    .where(eq(job.id, row.id));
}

// Puts a claimed job back as it was before the claim, its attempts included; `later`
// also moves it back in the queue and says why.
async function releaseJob(db: Db, before: JobRow, later?: { runAt: Date; lastError: string }) {
  await db
    .update(job)
    .set({ status: before.status, attempts: before.attempts, lockedAt: null, lockedBy: null, ...later })
    .where(eq(job.id, before.id));
}

// Jobs left running past STUCK_AFTER_MS go back to retry, or to dead (alerted) when that
// was their last attempt.
async function reapStuckJobs(db: Db, options: RunJobsOptions, summary: JobsSummary) {
  const now = options.now;
  const stuck = and(eq(job.status, "running"), lt(job.lockedAt, new Date(now.getTime() - STUCK_AFTER_MS)));
  const lastError = "Still running after 15 minutes, so it was stopped and tried again";
  const dead = await db
    .update(job)
    .set({ status: "dead", finishedAt: now, lastError, lockedAt: null, lockedBy: null })
    .where(and(stuck, gte(job.attempts, job.maxAttempts)))
    .returning();
  const retried = await db.update(job).set({ status: "retry", runAt: now, lastError, lockedAt: null, lockedBy: null }).where(stuck).returning({ id: job.id });
  summary.dead += dead.length;
  summary.retried += retried.length;
  for (const row of dead) await alertDead(db, row, lastError, options.providers, now);
}

// Driver errors are wrapped by Drizzle in an error whose message carries the query and
// its parameters, which can include answer text; the driver's own message underneath
// names the problem without them. Everything else here is written to be safe to store.
function describeError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const text =
    cause instanceof Error && "code" in cause
      ? `Database error ${String((cause as { code?: unknown }).code)}: ${cause.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return text.slice(0, ERROR_MAX_LENGTH);
}

// One kind for every job, so jobs dying together send one email an hour, not one each.
async function alertDead(db: Db, row: JobRow, error: string, providers: Providers, now: Date) {
  await notifyAdmin(
    db,
    "job_dead",
    `A ${row.kind} job gave up after ${row.attempts} tries`,
    `Job ${row.id} (${row.kind}, payload ${JSON.stringify(row.payload)}) stopped retrying. Last error: ${error}\n` +
      "Nothing more happens to it on its own; once the cause is fixed, an Admin can re-score from the profile or from Settings, AI scoring. " +
      "Any more that give up this hour send no email of their own.",
    { providers, now },
  );
}

async function alertScoringUnavailable(db: Db, error: unknown, providers: Providers, now: Date) {
  await notifyAdmin(
    db,
    "scoring_unavailable",
    "AI scoring is paused: the scoring call cannot go through",
    `${describeError(error)}\nScoring jobs stay queued and are tried again on later passes. Check ANTHROPIC_API_KEY and the Anthropic account.`,
    { providers, now },
  );
}

async function alertCapReached(db: Db, cap: { employerId: string; date: string; cap: number }, providers: Providers, now: Date) {
  if (await capAlertSent(db, cap.employerId, cap.date)) return;
  await notifyAdmin(
    db,
    capAlertKind(cap.employerId, cap.date),
    "AI scoring reached its daily cap",
    `Scoring stopped for ${cap.date} (Central) after ${cap.cap} scores for employer ${cap.employerId}. The rest wait until midnight Central. Raise the cap in Settings, AI scoring if this is expected.`,
    { providers, now },
  );
}
