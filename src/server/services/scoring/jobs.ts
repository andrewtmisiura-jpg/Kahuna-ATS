import { and, eq, gte, inArray, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { aiScore, application, employer, job, message, role, rubric, rubricVersion, type ScoringMode } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "../actor";
import { writeAudit } from "../audit";
import { enqueueJobs, type NewJob } from "../jobs/queue";
import { addDays, centralDate, startOfCentralDay } from "../time";
import { ScoringRequestError } from "./errors";

// How scoring work gets into the job table (DATA_MODEL.md, ai_score and job): a job when
// an application is submitted, the cron's sweep for anything that missed one, an Admin's
// re-score, and the employer's daily cap the runner checks before each call.

export const SCORE_JOB = "score_application";

// One automatic job per application and rubric version, ever. A re-score gets a key of
// its own (rescoreDedupeKey), since a finished job keeps its key forever.
export function scoreDedupeKey(applicationId: string, rubricVersionId: string): string {
  return `score:${applicationId}:${rubricVersionId}`;
}

export function rescoreDedupeKey(applicationId: string, rubricVersionId: string, requestId: string): string {
  return `rescore:${applicationId}:${rubricVersionId}:${requestId}`;
}

export type LiveRubric = { rubricId: string; mode: ScoringMode; versionId: string | null; version: number | null };

// The role's rubric, its scoring mode and its one published version (null while none is).
export async function liveRubric(db: Db, roleId: string): Promise<LiveRubric | null> {
  const [row] = await db
    .select({ rubricId: rubric.id, mode: rubric.scoringMode, versionId: rubricVersion.id, version: rubricVersion.version })
    .from(rubric)
    .leftJoin(rubricVersion, and(eq(rubricVersion.rubricId, rubric.id), eq(rubricVersion.status, "published")))
    .where(eq(rubric.roleId, roleId));
  return row ?? null;
}

// Called inside the submit transition: queue the score now, so the next cron pass runs it.
export async function queueScoreForSubmission(db: Db, input: { applicationId: string; roleId: string; now: Date }): Promise<boolean> {
  const live = await liveRubric(db, input.roleId);
  if (!live?.versionId || live.mode === "off") return false;
  const queued = await enqueueJobs(
    db,
    [scoreJob(input.applicationId, live.versionId, input.now, scoreDedupeKey(input.applicationId, live.versionId))],
    input.now,
  );
  return queued.length > 0;
}

// The sweep at the start of the cron's jobs step: a job for every submitted application
// (open, hired or closed, so later reports can set scores beside outcomes) in a role
// whose rubric is hidden or visible and published, with no score and no automatic job
// for that version yet. Applications submitted before scoring was turned on, or before
// a new version was published, are picked up this way. Returns how many it queued.
export async function queueMissingScores(db: Db, now: Date): Promise<number> {
  const rows = await db
    .select({ applicationId: application.id, rubricVersionId: rubricVersion.id })
    .from(application)
    .innerJoin(rubric, eq(rubric.roleId, application.roleId))
    .innerJoin(rubricVersion, and(eq(rubricVersion.rubricId, rubric.id), eq(rubricVersion.status, "published")))
    .where(
      and(
        inArray(rubric.scoringMode, ["hidden", "visible"]),
        isNotNull(application.submittedAt),
        isNull(application.deletedAt),
        sql`not exists (select 1 from ai_score s where s.application_id = ${application.id} and s.rubric_version_id = ${rubricVersion.id})`,
        sql`not exists (select 1 from job j where j.dedupe_key = 'score:' || ${application.id} || ':' || ${rubricVersion.id})`,
      ),
    );
  const queued = await enqueueJobs(
    db,
    rows.map((row) => scoreJob(row.applicationId, row.rubricVersionId, now, scoreDedupeKey(row.applicationId, row.rubricVersionId))),
    now,
  );
  return queued.length;
}

// A score job for this application that has not finished yet.
export async function pendingScoreJob(db: Db, applicationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.kind, SCORE_JOB), inArray(job.status, ["queued", "retry", "running"]), sql`${job.payload}->>'application_id' = ${applicationId}`))
    .limit(1);
  return Boolean(row);
}

export type RescoreRequestResult = { queued: boolean };

// An Admin's "Re-score" on the profile: one job against the role's published version,
// run by the next cron pass, unless a score is already on its way. Audited.
export async function requestRescore(db: Db, input: { applicationId: string; actorUserId: string; now?: Date }): Promise<RescoreRequestResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select({ id: application.id, personId: application.personId, roleId: application.roleId, submittedAt: application.submittedAt, deletedAt: application.deletedAt })
      .from(application)
      .where(eq(application.id, input.applicationId));
    if (!app || app.deletedAt) throw new ScoringRequestError("application_not_found", "No such application");
    if (!app.submittedAt) throw new ScoringRequestError("not_submitted", "Only a submitted application can be scored");
    const versionId = await scorableVersion(tx, app.roleId);
    if (await pendingScoreJob(tx, app.id)) return { queued: false };

    const [jobId] = await enqueueJobs(
      tx,
      [scoreJob(app.id, versionId, now, rescoreDedupeKey(app.id, versionId, uuidv7()), input.actorUserId)],
      now,
    );
    await writeAudit(tx, {
      actor: staffActor(input.actorUserId),
      action: "ai_score.rescore_request",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: { rubric_version_id: versionId, job_id: jobId ?? null },
      occurredAt: now,
    });
    return { queued: true };
  });
}

// The published version a staff re-score runs against, or the reason there is none.
export async function scorableVersion(db: Db, roleId: string): Promise<string> {
  const live = await liveRubric(db, roleId);
  if (!live) throw new ScoringRequestError("no_rubric", "This role has no rubric yet. An Admin writes one in Settings, AI scoring.");
  if (live.mode === "off") throw new ScoringRequestError("scoring_off", "Scoring is off for this role. An Admin turns it on in Settings, AI scoring.");
  if (!live.versionId) throw new ScoringRequestError("rubric_not_published", "This role's rubric has no published version yet.");
  return live.versionId;
}

export function scoreJob(applicationId: string, rubricVersionId: string, runAt: Date, dedupeKey: string, requestedByUserId?: string): NewJob {
  return {
    kind: SCORE_JOB,
    payload: { application_id: applicationId, rubric_version_id: rubricVersionId, ...(requestedByUserId ? { requested_by_user_id: requestedByUserId } : {}) },
    runAt,
    dedupeKey,
  };
}

// ---------------------------------------------------------------------------
// The daily cap (DATA_MODEL.md, employer.scoring_daily_cap)

export type ScoringCap = {
  employerId: string;
  cap: number;
  // Scores completed so far this Central day: each one is a model call.
  used: number;
  reached: boolean;
  // The Central date counted, and when the next one starts.
  date: string;
  resumesAt: Date;
};

// The cap that applies to scoring this application now: its employer's scoring_daily_cap
// against the scores completed for that employer since midnight Central. A no-op job
// (missing answers) calls nothing and writes no score, so it never counts.
export async function scoringCapFor(db: Db, applicationId: string, now: Date): Promise<ScoringCap | null> {
  const [owner] = await db
    .select({ employerId: employer.id, cap: employer.scoringDailyCap })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .innerJoin(employer, eq(employer.id, role.employerId))
    .where(eq(application.id, applicationId));
  if (!owner) return null;
  const date = centralDate(now);
  const resumesAt = startOfCentralDay(addDays(date, 1));
  const used = await scoringCallsOn(db, owner.employerId, date);
  return { employerId: owner.employerId, cap: owner.cap, used, reached: used >= owner.cap, date, resumesAt };
}

export async function scoringCallsOn(db: Db, employerId: string, date: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiScore)
    .innerJoin(application, eq(application.id, aiScore.applicationId))
    .innerJoin(role, eq(role.id, application.roleId))
    .where(
      and(
        eq(role.employerId, employerId),
        gte(aiScore.completedAt, startOfCentralDay(date)),
        lt(aiScore.completedAt, startOfCentralDay(addDays(date, 1))),
      ),
    );
  return row?.count ?? 0;
}

// The alert kind for one employer's cap on one Central day. notifyAdmin dedupes per hour,
// so capAlertSent looks for any hour of the day before alerting again.
export function capAlertKind(employerId: string, date: string): string {
  return `scoring_daily_cap:${employerId}:${date}`;
}

export async function capAlertSent(db: Db, employerId: string, date: string): Promise<boolean> {
  const [row] = await db
    .select({ id: message.id })
    .from(message)
    .where(like(message.dedupeKey, `alert:${capAlertKind(employerId, date)}:%`))
    .limit(1);
  return Boolean(row);
}
