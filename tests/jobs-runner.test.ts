import { hostname } from "node:os";
import { and, eq, inArray, lte, sql as raw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiScore, auditLog, employer, job, rubric } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { createApplication as startApplication, transition } from "@/server/services/applications/transition";
import { addQuestion, ensureDraft } from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";
import { runDueJobs, STUCK_AFTER_MS, type RunJobsOptions } from "@/server/services/jobs/run";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { ScorerError } from "@/server/services/scoring/errors";
import { fakeScorer } from "@/server/services/scoring/fake";
import { queueMissingScores, requestRescore, scoreDedupeKey, scoringCallsOn, scoringCapFor } from "@/server/services/scoring/jobs";
import { enqueueRescore } from "@/server/services/scoring/rescore";
import type { Scorer } from "@/server/services/scoring/types";
import { withRollback } from "./helpers/db";
import { createApplication, createPerson, loadAdminId, loadEmployer, loadOption, loadSnow, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createRubricVersion, ensureRubric } from "./helpers/phase2";
import { createScoringRole, submitScoringApplication, type ScoringRoleFixture } from "./helpers/scoring";

// The cron's jobs step (jobs/run.ts) and the scoring work it runs: claiming, backoff,
// dead jobs, reaping, the time budget, the daily cap, the sweep and re-scores. All but
// the last case run inside a rolled-back transaction on a role of their own; the last
// needs two real connections, so it uses the snow role and turns its scoring off again.

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function options(overrides: Partial<RunJobsOptions> = {}): RunJobsOptions {
  return { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer, ...overrides };
}

async function jobsFor(tx: Tx, applicationId: string) {
  return tx.select().from(job).where(raw`${job.payload}->>'application_id' = ${applicationId}`);
}

async function submitted(tx: Tx, role: ScoringRoleFixture, answers: Record<string, string> = { commitment: "Called ahead.", mistake: "Told them." }) {
  return (await submitScoringApplication(tx, role, answers)).applicationId;
}

const minutes = (n: number) => n * 60_000;

describe("claiming and running", () => {
  it("queues a job at submit, then claims it, marks it running with a lock and finishes it", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const applicationId = await submitted(tx, role);
      const [queued] = await jobsFor(tx, applicationId);
      expect(queued).toMatchObject({
        kind: "score_application",
        status: "queued",
        attempts: 0,
        dedupeKey: scoreDedupeKey(applicationId, role.published.rubricVersionId),
        payload: { application_id: applicationId, rubric_version_id: role.published.rubricVersionId },
      });

      let during: typeof queued | undefined;
      const watching: Scorer = {
        async score(r, input) {
          [during] = await jobsFor(tx, applicationId);
          return fakeScorer.score(r, input);
        },
      };
      const summary = await runDueJobs(tx, options({ scorer: watching }));
      expect(summary).toEqual({ claimed: 1, succeeded: 1, retried: 0, dead: 0, deferredByCap: 0 });
      expect(during).toMatchObject({ status: "running", attempts: 1, lockedBy: `${hostname()}:${process.pid}` });
      expect(during!.lockedAt).toBeInstanceOf(Date);
      const [done] = await jobsFor(tx, applicationId);
      expect(done).toMatchObject({ status: "succeeded", attempts: 1, lockedAt: null, lockedBy: null, lastError: null });
      expect(done!.finishedAt).toBeInstanceOf(Date);
      expect(await tx.select().from(aiScore).where(eq(aiScore.applicationId, applicationId))).toHaveLength(1);
    });
  });

  it("leaves a job not yet due, a job of a role whose scoring is off, and a kind it does not know", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const later = await submitted(tx, role);
      await tx.update(job).set({ runAt: new Date(Date.now() + minutes(10)) }).where(raw`${job.payload}->>'application_id' = ${later}`);
      // A kind a newer build might queue: left for that build.
      const unknownId = uuidv7();
      await tx.insert(job).values({ id: unknownId, kind: "purge_expired", payload: { application_id: later }, runAt: new Date(Date.now() - minutes(1)) });
      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 0 });

      const off = await createScoringRole(tx, { adminId });
      const waiting = await submitted(tx, off);
      await tx.update(rubric).set({ scoringMode: "off" }).where(eq(rubric.id, off.rubricId));
      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 0 });
      expect((await jobsFor(tx, waiting))[0]).toMatchObject({ status: "queued", attempts: 0 });
      expect((await tx.select().from(job).where(eq(job.id, unknownId)))[0]).toMatchObject({ status: "queued", attempts: 0 });

      // Turning scoring back on picks the waiting job up.
      await tx.update(rubric).set({ scoringMode: "hidden" }).where(eq(rubric.id, off.rubricId));
      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 1, succeeded: 1 });
      expect((await jobsFor(tx, waiting))[0]).toMatchObject({ status: "succeeded" });
    });
  });

  it("retries a failure after 2, 4, 8 and 16 minutes, then marks it dead with one alert", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const applicationId = await submitted(tx, role);
      const failing: Scorer = {
        score: async () => {
          throw new ScorerError("retryable", "Anthropic answered 529 overloaded_error; trying again later");
        },
      };
      const sink = createSinkProviders();
      let now = new Date();
      for (const backoff of [2, 4, 8, 16]) {
        expect(await runDueJobs(tx, options({ now, scorer: failing, providers: sink }))).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
        const [row] = await jobsFor(tx, applicationId);
        expect(row).toMatchObject({ status: "retry", lockedAt: null, lastError: "Anthropic answered 529 overloaded_error; trying again later" });
        const wait = row!.runAt.getTime() - now.getTime();
        expect(wait).toBeGreaterThanOrEqual(minutes(backoff));
        expect(wait).toBeLessThan(minutes(backoff) + 5_000);
        // Not claimed a moment before its time.
        expect(await runDueJobs(tx, options({ now: new Date(row!.runAt.getTime() - 1_000), scorer: failing, providers: sink }))).toMatchObject({ claimed: 0 });
        now = row!.runAt;
      }
      expect(await runDueJobs(tx, options({ now, scorer: failing, providers: sink }))).toMatchObject({ claimed: 1, retried: 0, dead: 1 });
      const [dead] = await jobsFor(tx, applicationId);
      expect(dead).toMatchObject({ status: "dead", attempts: 5, lockedAt: null });
      expect(dead!.finishedAt).toBeInstanceOf(Date);
      expect(await runDueJobs(tx, options({ now: new Date(now.getTime() + minutes(120)), scorer: failing, providers: sink }))).toMatchObject({ claimed: 0 });
      const alerts = sink.sent.flatMap((s) => (s.channel === "email" && s.message.subject.includes("gave up") ? [s.message] : []));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.subject).toBe("[Tidepool] A score_application job gave up after 5 tries");
      expect(alerts[0]!.body).toContain(dead!.id);
      expect(await tx.select().from(aiScore).where(eq(aiScore.applicationId, applicationId))).toEqual([]);
    });
  });

  it("pauses scoring for the rest of the pass when the call cannot go through, and alerts", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const first = await submitted(tx, role);
      const second = await submitted(tx, role);
      let calls = 0;
      const refused: Scorer = {
        score: async () => {
          calls += 1;
          throw new ScorerError("unavailable", "Anthropic refused the scoring call (401 authentication_error)");
        },
      };
      const sink = createSinkProviders();
      expect(await runDueJobs(tx, options({ scorer: refused, providers: sink }))).toMatchObject({ claimed: 1, retried: 1 });
      expect(calls).toBe(1);
      const states = [(await jobsFor(tx, first))[0]!.status, (await jobsFor(tx, second))[0]!.status].sort();
      expect(states).toEqual(["queued", "retry"]);
      expect(sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("AI scoring is paused"))).toHaveLength(1);
    });
  });

  it("stops claiming once the time budget has passed", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      for (let i = 0; i < 3; i += 1) await submitted(tx, role);
      const slow: Scorer = {
        async score(r, input) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fakeScorer.score(r, input);
        },
      };
      expect(await runDueJobs(tx, options({ scorer: slow, timeBudgetMs: 250 }))).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(await runDueJobs(tx, options({ scorer: slow, timeBudgetMs: 0 }))).toMatchObject({ claimed: 0 });
      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 2, succeeded: 2 });
    });
  });

  it("puts a job running for more than 15 minutes back to retry, or dead on its last attempt", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const stuck = await submitted(tx, role);
      const spent = await submitted(tx, role);
      // Scoring off, so the reaped job is not run again in the same pass.
      await tx.update(rubric).set({ scoringMode: "off" }).where(eq(rubric.id, role.rubricId));
      const now = new Date();
      const lockedAt = new Date(now.getTime() - STUCK_AFTER_MS - 1_000);
      await tx.update(job).set({ status: "running", attempts: 2, lockedAt, lockedBy: "gone:1" }).where(raw`${job.payload}->>'application_id' = ${stuck}`);
      await tx.update(job).set({ status: "running", attempts: 5, lockedAt, lockedBy: "gone:2" }).where(raw`${job.payload}->>'application_id' = ${spent}`);
      const sink = createSinkProviders();
      expect(await runDueJobs(tx, options({ now, providers: sink }))).toMatchObject({ claimed: 0, retried: 1, dead: 1 });
      expect((await jobsFor(tx, stuck))[0]).toMatchObject({ status: "retry", attempts: 2, lockedAt: null, lockedBy: null, lastError: expect.stringContaining("15 minutes") });
      expect((await jobsFor(tx, spent))[0]).toMatchObject({ status: "dead", attempts: 5, lockedAt: null });
      expect(sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("gave up"))).toHaveLength(1);
      // One that has run for less than 15 minutes is left alone.
      await tx.update(job).set({ status: "running", lockedAt: new Date(now.getTime() - minutes(5)) }).where(raw`${job.payload}->>'application_id' = ${stuck}`);
      expect(await runDueJobs(tx, options({ now }))).toMatchObject({ retried: 0, dead: 0 });
      expect((await jobsFor(tx, stuck))[0]).toMatchObject({ status: "running" });
    });
  });
});

describe("the daily cap", () => {
  // 10am CDT on Tue Mar 10, 2026: a day no other test scores on.
  const MORNING = new Date("2026-03-10T15:00:00Z");

  it("leaves scoring jobs past the cap for the next Central day and alerts once that day", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const emp = await loadEmployer(tx);
      const used = await scoringCallsOn(tx, emp.id, "2026-03-10");
      await tx.update(employer).set({ scoringDailyCap: used + 2 }).where(eq(employer.id, emp.id));
      const ids = [await submitted(tx, role), await submitted(tx, role), await submitted(tx, role)];
      const dueBy = (when: Date) => tx.update(job).set({ runAt: new Date(when.getTime() - minutes(1)) }).where(inArray(raw`${job.payload}->>'application_id'`, ids));
      await dueBy(MORNING);
      const sink = createSinkProviders();
      expect(await runDueJobs(tx, options({ now: MORNING, providers: sink }))).toEqual({ claimed: 2, succeeded: 2, retried: 0, dead: 0, deferredByCap: 1 });
      const cap = (await scoringCapFor(tx, ids[0]!, MORNING))!;
      expect(cap).toMatchObject({ reached: true, used: used + 2, cap: used + 2, date: "2026-03-10", resumesAt: new Date("2026-03-11T05:00:00Z") });
      const waiting = (await tx.select().from(job).where(inArray(raw`${job.payload}->>'application_id'`, ids))).filter((row) => row.status === "queued");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ runAt: cap.resumesAt, attempts: 0 });

      // An hour later the same day, another submission waits too, without a second alert.
      const later = new Date(MORNING.getTime() + minutes(65));
      const another = await submitted(tx, role);
      await tx.update(job).set({ runAt: MORNING }).where(raw`${job.payload}->>'application_id' = ${another}`);
      expect(await runDueJobs(tx, options({ now: later, providers: sink }))).toMatchObject({ claimed: 0, deferredByCap: 1 });
      expect(sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("daily cap"))).toHaveLength(1);

      // From midnight Central the waiting jobs run.
      expect(await runDueJobs(tx, options({ now: new Date(cap.resumesAt.getTime() + minutes(1)), providers: sink }))).toMatchObject({ claimed: 2, succeeded: 2 });
    });
  });

  it("counts the Central day across the end of daylight saving time", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const applicationId = await submitted(tx, role);
      // 11:30pm CST on Sun Nov 1, 2026, the 25-hour day: the next one starts at 06:00 UTC.
      expect(await scoringCapFor(tx, applicationId, new Date("2026-11-02T05:30:00Z"))).toMatchObject({
        date: "2026-11-01",
        resumesAt: new Date("2026-11-02T06:00:00Z"),
      });
      // Noon CDT on Sat Oct 31: Sunday starts at 05:00 UTC.
      expect(await scoringCapFor(tx, applicationId, new Date("2026-10-31T17:00:00Z"))).toMatchObject({
        date: "2026-10-31",
        resumesAt: new Date("2026-11-01T05:00:00Z"),
      });
    });
  });
});

describe("the sweep", () => {
  it("queues each submitted application without a score for the published version once, closed ones included", async () => {
    await withRollback(db, async (tx) => {
      // Scoring off while these come in, so nothing is queued at submit.
      const role = await createScoringRole(tx, { adminId, mode: "off" });
      const answered = await submitted(tx, role);
      const blank = await submitted(tx, role, { commitment: "Called ahead.", mistake: "" });
      const withdrew = await submitted(tx, role);
      const reasonOptionId = await loadOption(tx, "withdraw_reason", "took_another_job");
      await transition(tx, { action: "close", applicationId: withdrew, actor: staffActor(adminId), outcome: "withdrew", reasonOptionId });
      expect(await jobsFor(tx, answered)).toEqual([]);

      await tx.update(rubric).set({ scoringMode: "hidden" }).where(eq(rubric.id, role.rubricId));
      const now = new Date();
      expect(await queueMissingScores(tx, now)).toBe(3);
      expect(await queueMissingScores(tx, now)).toBe(0);
      expect(await runDueJobs(tx, options({ now }))).toMatchObject({ claimed: 3, succeeded: 3, retried: 0, dead: 0 });
      const scored = await tx.select().from(aiScore).where(inArray(aiScore.applicationId, [answered, blank, withdrew]));
      expect(scored.map((s) => s.applicationId).sort()).toEqual([answered, withdrew].sort());
      // A closed application is scored too, and marked as scored after the decision.
      expect(scored.find((s) => s.applicationId === withdrew)).toMatchObject({ scoredAfterDecision: true, hiddenFromReviewers: true });
      // The blank one sent nothing; its job keeps its key, so it is never queued again.
      expect(await jobsFor(tx, blank)).toMatchObject([{ status: "succeeded" }]);
      expect(await queueMissingScores(tx, now)).toBe(0);
    });
  });

  it("scores form v2 applications against a rubric that reads a v2 question, and leaves form v1 ones as they were", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const onV1 = await submitted(tx, role);
      await runDueJobs(tx, options());

      // The owner adds a question in form v2 and a rubric version that reads it, as snow did on Oct 16.
      const actor = staffActor(adminId);
      const draft = await ensureDraft(tx, { roleId: role.roleId, actor });
      const added = await addQuestion(tx, { formVersionId: draft.id, sectionKey: "basics", key: "forgot_equipment", type: "long_text", prompt: "You forgot equipment. What do you do?", required: true, actor });
      await publishForm(tx, { formVersionId: draft.id, changeReason: "Added a problem-solving question", actor });
      const v2 = await createRubricVersion(tx, role.rubricId, {
        published: true,
        criteria: [
          { key: "reliability", weight: 2, questionIds: [role.questions.commitment!] },
          { key: "problem_solving", weight: 1, questionIds: [added.questionId] },
        ],
      });
      const onV2 = await submitScoringApplication(tx, { ...role, versions: { ...role.versions, forgot_equipment: added.questionVersionId } }, {
        commitment: "Called ahead.",
        forgot_equipment: "Tell the customer and finish what I can [score:4].",
      });

      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 2, succeeded: 2, retried: 0, dead: 0 });
      const v2Scores = await tx.select().from(aiScore).where(eq(aiScore.rubricVersionId, v2.rubricVersionId));
      expect(v2Scores.map((s) => s.applicationId)).toEqual([onV2.applicationId]);
      // The form v1 application has nothing to read for the new criterion: no v2 score, and its v1 score stays current.
      const [kept] = await tx.select().from(aiScore).where(and(eq(aiScore.applicationId, onV1), eq(aiScore.isCurrent, true)));
      expect(kept).toMatchObject({ rubricVersionId: role.published.rubricVersionId, status: "succeeded" });
      expect((await jobsFor(tx, onV1)).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    });
  });
});

describe("re-scoring", () => {
  it("queues an Admin's re-score with a key of its own, once while it waits, and lands it as the current score", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const applicationId = await submitted(tx, role);
      await runDueJobs(tx, options());
      expect(await requestRescore(tx, { applicationId, actorUserId: adminId })).toEqual({ queued: true });
      expect(await requestRescore(tx, { applicationId, actorUserId: adminId })).toEqual({ queued: false });
      const pending = (await jobsFor(tx, applicationId)).find((row) => row.status === "queued")!;
      expect(pending.dedupeKey).toMatch(new RegExp(`^rescore:${applicationId}:${role.published.rubricVersionId}:`));
      expect(pending.payload).toMatchObject({ requested_by_user_id: adminId });
      expect(await runDueJobs(tx, options())).toMatchObject({ claimed: 1, succeeded: 1 });
      const rows = await tx.select().from(aiScore).where(eq(aiScore.applicationId, applicationId));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.isCurrent)).toMatchObject({ requestedByType: "staff", requestedByUserId: adminId });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.action, "ai_score.rescore_request"), eq(auditLog.applicationId, applicationId)));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: "staff", actorUserId: adminId, changes: { rubric_version_id: role.published.rubricVersionId } });
    });
  });

  it("re-scores every submitted application of a role, skipping ones already waiting, and refuses while scoring is off", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const a = await submitted(tx, role);
      await submitted(tx, role);
      // A started application is never scored.
      await createApplication(tx, { roleId: role.roleId, openingId: role.openingId, formVersionId: role.formVersionId, startedStageId: role.stages.started! }, await createPerson(tx));
      // Both submit jobs still wait, so nothing new is queued for them.
      expect(await enqueueRescore(tx, { roleId: role.roleId, actorUserId: adminId })).toEqual({ queued: 0 });
      await runDueJobs(tx, options());
      expect(await enqueueRescore(tx, { roleId: role.roleId, actorUserId: adminId })).toEqual({ queued: 2 });
      expect((await jobsFor(tx, a)).filter((row) => row.status === "queued")).toHaveLength(1);
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.action, "ai_score.rescore_role"), eq(auditLog.entityId, role.roleId)));
      expect(audits.map((row) => row.changes)).toEqual(
        expect.arrayContaining([expect.objectContaining({ queued: 0 }), expect.objectContaining({ queued: 2, rubric_version_id: role.published.rubricVersionId })]),
      );

      await tx.update(rubric).set({ scoringMode: "off" }).where(eq(rubric.id, role.rubricId));
      await expect(enqueueRescore(tx, { roleId: role.roleId, actorUserId: adminId })).rejects.toMatchObject({ code: "scoring_off" });
      await expect(requestRescore(tx, { applicationId: a, actorUserId: adminId })).rejects.toMatchObject({ code: "scoring_off" });
    });
  });
});

describe("two passes at once", () => {
  it("never run one job twice", async () => {
    const snow = await loadSnow(db);
    const rubricId = await ensureRubric(db, snow.roleId);
    // A version whose criterion reads nothing: every job is a quick no-op that sends nothing and writes no score.
    await createRubricVersion(db, rubricId, { published: true, criteria: [{ key: "reliability", questionIds: [] }] });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { applicationId } = await startApplication(db, { personId: await createPerson(db), openingId: snow.openingId, origin: "landing", entryChannel: "role_qr", actor: { type: "applicant" } });
      await transition(db, { action: "submit", applicationId, actor: { type: "applicant" } });
      ids.push(applicationId);
    }
    await db.update(rubric).set({ scoringMode: "hidden" }).where(eq(rubric.id, rubricId));
    try {
      const now = new Date();
      await queueMissingScores(db, now);
      // Every due snow scoring job, these four and any for snow applications other files left submitted.
      const due = await db
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            inArray(job.status, ["queued", "retry"]),
            eq(job.kind, "score_application"),
            lte(job.runAt, now),
            raw`${job.payload}->>'application_id' in (select id::text from application where role_id = ${snow.roleId})`,
          ),
        );
      const [a, b] = await Promise.all([runDueJobs(db, options({ now })), runDueJobs(db, options({ now }))]);
      const mine = await db.select().from(job).where(inArray(raw`${job.payload}->>'application_id'`, ids));
      expect(mine).toHaveLength(4);
      for (const row of mine) expect(row).toMatchObject({ status: "succeeded", attempts: 1 });
      expect(a.claimed + b.claimed).toBe(due.length);
      expect(a.succeeded + b.succeeded).toBe(due.length);
    } finally {
      await db.update(rubric).set({ scoringMode: "off" }).where(eq(rubric.id, rubricId));
    }
  });
});
