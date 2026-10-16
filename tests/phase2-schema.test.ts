import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql as raw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import {
  aiCriterionScore,
  aiScore,
  assessment,
  employer,
  job,
  reviewDecision,
  rubric,
  rubricVersion,
  rubricVersionCriterion,
  star,
} from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { expectPgError, PG, withRollback } from "./helpers/db";
import {
  createApplication,
  createPerson,
  loadAdminId,
  loadEmployer,
  loadOption,
  loadSnow,
  nextMobile,
  TEST_ADMIN_EMAIL,
  type SnowFixture,
} from "./helpers/fixtures";
import { createAiScore, createAttendee, createGroupSession, createRubricVersion, ensureRubric } from "./helpers/phase2";

// drizzle/0007_phase2_tables.sql and 0008_phase2_triggers_and_grants.sql: the Phase 2
// tables, their checks and partial uniques, the triggers that join the two generic
// functions from 0001, and the read-only user's grants.

let snow: SnowFixture;
let adminId: string;
let rubricId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
  rubricId = await ensureRubric(db, snow.roleId);
});

afterAll(async () => {
  await sql.end();
});

async function newApplication() {
  const personId = await createPerson(db);
  return createApplication(db, snow, personId);
}

describe("tables and types", () => {
  it("creates every Phase 2 enum with its values in order", async () => {
    const rows = await db.execute<{ typname: string; labels: string[] }>(
      raw`select t.typname, array_agg(e.enumlabel order by e.enumsortorder)::text[] as labels
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          where t.typname in ('job_status', 'attendee_source', 'star_mark', 'scoring_mode', 'ai_score_status',
            'review_decision_value', 'interview_kind', 'interview_status', 'interview_grade_value',
            'interview_recommendation', 'assessment_result')
          group by t.typname order by t.typname`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.typname, r.labels]))).toEqual({
      ai_score_status: ["queued", "succeeded", "failed", "invalid_output"],
      assessment_result: ["pass", "fail", "did_not_attempt"],
      attendee_source: ["paper_sheet", "door_checkin", "staff_added"],
      interview_grade_value: ["a_plus", "a", "a_minus", "b_plus", "b", "b_minus", "c_plus", "c", "c_minus", "d", "f"],
      interview_kind: ["one_on_one", "phone_screen"],
      interview_recommendation: ["hire", "maybe", "no_hire"],
      interview_status: ["scheduled", "held", "no_show", "canceled"],
      job_status: ["queued", "running", "retry", "succeeded", "dead"],
      review_decision_value: ["advance", "hold", "decline"],
      scoring_mode: ["off", "hidden", "visible"],
      star_mark: ["star", "concern"],
    });
  });

  it("gives the employer a booking link and a scoring cap of 100 a day, above zero", async () => {
    const kahuna = await loadEmployer(db);
    expect(kahuna.bookingLinkUrl).toBeNull();
    expect(kahuna.scoringDailyCap).toBe(100);
    await expectPgError(db.update(employer).set({ scoringDailyCap: 0 }).where(eq(employer.id, kahuna.id)), PG.checkViolation);
  });
});

describe("review_decision", () => {
  it("rejects UPDATE and DELETE", async () => {
    const { applicationId } = await newApplication();
    const id = uuidv7();
    await db.insert(reviewDecision).values({ id, applicationId, decision: "hold", aiScoreVisible: false, decidedBy: adminId, decidedAt: new Date() });
    await expectPgError(db.update(reviewDecision).set({ decision: "advance" }).where(eq(reviewDecision.id, id)), PG.appendOnly);
    await expectPgError(db.delete(reviewDecision).where(eq(reviewDecision.id, id)), PG.appendOnly);
  });

  it("rejects a decline without a reason", async () => {
    const { applicationId } = await newApplication();
    const decline = { applicationId, decision: "decline" as const, aiScoreVisible: true, decidedBy: adminId, decidedAt: new Date() };
    await expectPgError(db.insert(reviewDecision).values({ id: uuidv7(), ...decline }), PG.checkViolation);
    const reasonOptionId = await loadOption(db, "disqualify_reason", "availability_conflict");
    await withRollback(db, async (tx) => {
      await tx.insert(reviewDecision).values({ id: uuidv7(), ...decline, reasonOptionId });
    });
  });
});

describe("rubric versions", () => {
  it("allows one rubric per role and one published version per rubric", async () => {
    await expectPgError(db.insert(rubric).values({ id: uuidv7(), roleId: snow.roleId }), PG.uniqueViolation);
    await createRubricVersion(db, rubricId, { published: true, publishedBy: adminId });
    const [live] = await db
      .select({ version: rubricVersion.version })
      .from(rubricVersion)
      .where(and(eq(rubricVersion.rubricId, rubricId), eq(rubricVersion.status, "published")));
    await expectPgError(
      db.insert(rubricVersion).values({ id: uuidv7(), rubricId, version: live!.version + 100, status: "published", instructions: "x", allowedFlags: [] }),
      PG.uniqueViolation,
    );
  });

  it("locks a published version except for retiring it", async () => {
    const { rubricVersionId } = await createRubricVersion(db, rubricId, { published: true, publishedBy: adminId });
    await expectPgError(db.update(rubricVersion).set({ instructions: "Edited" }).where(eq(rubricVersion.id, rubricVersionId)), PG.immutablePublished);
    await expectPgError(db.delete(rubricVersion).where(eq(rubricVersion.id, rubricVersionId)), PG.immutablePublished);
    // Retiring may not carry other edits with it.
    await expectPgError(
      db.update(rubricVersion).set({ status: "retired", changeReason: "Edited" }).where(eq(rubricVersion.id, rubricVersionId)),
      PG.immutablePublished,
    );

    await withRollback(db, async (tx) => {
      await tx.update(rubricVersion).set({ status: "retired" }).where(eq(rubricVersion.id, rubricVersionId));
      const [row] = await tx.select({ status: rubricVersion.status }).from(rubricVersion).where(eq(rubricVersion.id, rubricVersionId));
      expect(row?.status).toBe("retired");
      // Retired is locked too, and status cannot move back.
      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.update(rubricVersion).set({ status: "published" }).where(eq(rubricVersion.id, rubricVersionId));
        }),
        PG.immutablePublished,
      );
    });
  });

  it("leaves a draft version and its criteria editable", async () => {
    const { rubricVersionId, criteria } = await createRubricVersion(db, rubricId);
    await withRollback(db, async (tx) => {
      await tx.update(rubricVersion).set({ instructions: "Draft wording" }).where(eq(rubricVersion.id, rubricVersionId));
      await tx.update(rubricVersionCriterion).set({ weight: 3.5 }).where(eq(rubricVersionCriterion.rubricVersionId, rubricVersionId));
      const [row] = await tx
        .select({ weight: rubricVersionCriterion.weight })
        .from(rubricVersionCriterion)
        .where(and(eq(rubricVersionCriterion.rubricVersionId, rubricVersionId), eq(rubricVersionCriterion.criterionId, criteria[0]!.criterionId)));
      expect(row?.weight).toBe(3.5);
      await tx.delete(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, rubricVersionId));
      await tx.delete(rubricVersion).where(eq(rubricVersion.id, rubricVersionId));
    });
  });

  it("locks the criteria of a published version", async () => {
    const { rubricVersionId, criteria } = await createRubricVersion(db, rubricId, { published: true, publishedBy: adminId });
    const first = and(eq(rubricVersionCriterion.rubricVersionId, rubricVersionId), eq(rubricVersionCriterion.criterionId, criteria[0]!.criterionId));
    await expectPgError(db.update(rubricVersionCriterion).set({ weight: 9 }).where(first), PG.immutablePublished);
    await expectPgError(db.delete(rubricVersionCriterion).where(first), PG.immutablePublished);
    const draft = await createRubricVersion(db, rubricId, { criteria: [{ key: "problem_solving" }] });
    await expectPgError(
      db.insert(rubricVersionCriterion).values({
        rubricVersionId,
        criterionId: draft.criteria[0]!.criterionId,
        name: "Problem solving",
        guidanceStrong: "s",
        guidanceAcceptable: "a",
        guidanceWeak: "w",
        weight: 1,
        questionIds: [],
        sortOrder: 99,
      }),
      PG.immutablePublished,
    );
  });

  it("needs a weight above zero", async () => {
    await expectPgError(createRubricVersion(db, rubricId, { criteria: [{ key: "reliability", weight: 0 }] }), PG.checkViolation);
  });
});

describe("ai_score", () => {
  it("keeps the overall score between 1 and 100, set exactly when the score succeeded", async () => {
    const { applicationId } = await newApplication();
    const { rubricVersionId } = await createRubricVersion(db, rubricId);
    const base = { applicationId, rubricVersionId };
    await expectPgError(createAiScore(db, { ...base, overallScore: 0 }), PG.checkViolation);
    await expectPgError(createAiScore(db, { ...base, overallScore: 101 }), PG.checkViolation);
    await expectPgError(createAiScore(db, { ...base, overallScore: null }), PG.checkViolation);
    // A failed or invalid result is "not scored", never a low number.
    await expectPgError(createAiScore(db, { ...base, status: "failed", overallScore: 1 }), PG.checkViolation);
    await withRollback(db, async (tx) => {
      await createAiScore(tx, { ...base, overallScore: 1 });
      await createAiScore(tx, { ...base, overallScore: 100 });
      await createAiScore(tx, { ...base, status: "invalid_output", error: "not JSON" });
      await createAiScore(tx, { ...base, status: "queued" });
    });
  });

  it("allows one current score per application", async () => {
    const { applicationId } = await newApplication();
    const { rubricVersionId } = await createRubricVersion(db, rubricId);
    await createAiScore(db, { applicationId, rubricVersionId, isCurrent: true });
    await expectPgError(createAiScore(db, { applicationId, rubricVersionId, isCurrent: true }), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await createAiScore(tx, { applicationId, rubricVersionId, isCurrent: false });
    });
  });

  it("locks a completed score except is_current, and leaves a queued one editable", async () => {
    const { applicationId } = await newApplication();
    const { rubricVersionId } = await createRubricVersion(db, rubricId);
    const done = await createAiScore(db, { applicationId, rubricVersionId, isCurrent: true });
    await expectPgError(db.update(aiScore).set({ overallScore: 99 }).where(eq(aiScore.id, done)), PG.immutablePublished);
    await expectPgError(db.update(aiScore).set({ isCurrent: false, rationale: "edited" }).where(eq(aiScore.id, done)), PG.immutablePublished);
    await expectPgError(db.delete(aiScore).where(eq(aiScore.id, done)), PG.immutablePublished);
    await withRollback(db, async (tx) => {
      await tx.update(aiScore).set({ isCurrent: false }).where(eq(aiScore.id, done));
    });

    const queued = await createAiScore(db, { applicationId, rubricVersionId, status: "queued" });
    await withRollback(db, async (tx) => {
      await tx
        .update(aiScore)
        .set({ status: "succeeded", overallScore: 76, rationale: "Specific examples.", completedAt: new Date() })
        .where(eq(aiScore.id, queued));
      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.update(aiScore).set({ overallScore: 80 }).where(eq(aiScore.id, queued));
        }),
        PG.immutablePublished,
      );
    });
  });

  it("lets the Phase 3 purge strip a completed score", async () => {
    const { applicationId } = await newApplication();
    const { rubricVersionId } = await createRubricVersion(db, rubricId);
    const id = await createAiScore(db, { applicationId, rubricVersionId, rationale: "Mentions the applicant's answers." });
    await withRollback(db, async (tx) => {
      await tx.execute(raw`set local tidepool.purge = 'on'`);
      await tx.update(aiScore).set({ rationale: null, rawOutput: null }).where(eq(aiScore.id, id));
    });
  });

  it("keeps each criterion score between 1 and 5", async () => {
    const { applicationId } = await newApplication();
    const { rubricVersionId, criteria } = await createRubricVersion(db, rubricId);
    const scoreId = await createAiScore(db, { applicationId, rubricVersionId });
    const criterionId = criteria[0]!.criterionId;
    for (const score of [0, 6]) {
      await expectPgError(db.insert(aiCriterionScore).values({ aiScoreId: scoreId, criterionId, score }), PG.checkViolation);
    }
    await withRollback(db, async (tx) => {
      await tx.insert(aiCriterionScore).values({ aiScoreId: scoreId, criterionId, score: 5, rationale: "Specific." });
    });
  });
});

describe("attendees and stars", () => {
  it("matches an application to at most one attendee row per session", async () => {
    const sessionId = await createGroupSession(db, snow.openingId, adminId);
    const { applicationId } = await newApplication();
    await createAttendee(db, sessionId, { applicationId, matchMethod: "phone_match" });
    await expectPgError(createAttendee(db, sessionId, { applicationId }), PG.uniqueViolation);
    // Unmatched names are many; another session may match the same application.
    await createAttendee(db, sessionId);
    await createAttendee(db, sessionId);
    const otherSession = await createGroupSession(db, snow.openingId, adminId);
    await withRollback(db, async (tx) => {
      await createAttendee(tx, otherSession, { applicationId });
    });
  });

  it("stores only US mobiles and needs a name until the purge redacts it", async () => {
    const sessionId = await createGroupSession(db, snow.openingId, adminId);
    await expectPgError(createAttendee(db, sessionId, { mobileE164: "6125550123" }), PG.checkViolation);
    await expectPgError(createAttendee(db, sessionId, { nameAsWritten: null }), PG.checkViolation);
    await withRollback(db, async (tx) => {
      await createAttendee(tx, sessionId, { mobileE164: nextMobile(), source: "door_checkin" });
      await createAttendee(tx, sessionId, { nameAsWritten: null, redactedAt: new Date() });
    });
  });

  it("allows one live star and one live concern per staff member per attendee", async () => {
    const sessionId = await createGroupSession(db, snow.openingId, adminId);
    const attendeeId = await createAttendee(db, sessionId);
    const first = uuidv7();
    await db.insert(star).values({ id: first, attendeeId, userId: adminId, mark: "star" });
    await expectPgError(db.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "star" }), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await tx.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "concern" });
      await tx.update(star).set({ deletedAt: new Date() }).where(eq(star.id, first));
      await tx.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "star" });
    });
  });

  it("keeps a star note to 140 characters", async () => {
    const sessionId = await createGroupSession(db, snow.openingId, adminId);
    const attendeeId = await createAttendee(db, sessionId);
    await expectPgError(db.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "concern", note: "x".repeat(141) }), PG.checkViolation);
    await withRollback(db, async (tx) => {
      await tx.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "concern", note: "x".repeat(140) });
    });
  });
});

describe("assessments and jobs", () => {
  it("allows one live result per test per application", async () => {
    const { applicationId } = await newApplication();
    const ladder = await loadOption(db, "assessment_type", "ladder_test");
    const result = { applicationId, assessmentTypeOptionId: ladder, administeredBy: adminId, administeredOn: "2026-10-30" };
    const first = uuidv7();
    await db.insert(assessment).values({ id: first, ...result, result: "fail" });
    await expectPgError(db.insert(assessment).values({ id: uuidv7(), ...result, result: "pass" }), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await tx.update(assessment).set({ voidedAt: new Date() }).where(eq(assessment.id, first));
      await tx.insert(assessment).values({ id: uuidv7(), ...result, result: "pass" });
    });
  });

  it("queues a job once per dedupe key, with the defaults the runner reads", async () => {
    const dedupeKey = `score:${uuidv7()}`;
    const id = uuidv7();
    await db.insert(job).values({ id, kind: "score_application", payload: { applicationId: uuidv7() }, runAt: new Date(), dedupeKey });
    const [row] = await db.select().from(job).where(eq(job.id, id));
    expect(row).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 5, lockedAt: null, finishedAt: null });
    await expectPgError(
      db.insert(job).values({ id: uuidv7(), kind: "score_application", payload: {}, runAt: new Date(), dedupeKey }),
      PG.uniqueViolation,
    );
    // Jobs without a key never collide.
    await db.insert(job).values({ id: uuidv7(), kind: "rescore", payload: {}, runAt: new Date() });
    await db.insert(job).values({ id: uuidv7(), kind: "rescore", payload: {}, runAt: new Date() });
  });
});

// The read-only user (scripts/readonly-role.sql) reads every Phase 2 table, and 0008's
// grant gives it that even when its default privileges did not. A scratch role stands
// in for tidepool_readonly and is dropped afterwards.
describe("read-only user", () => {
  const ROLE = `tp_readonly_${randomBytes(4).toString("hex")}`;
  const PHASE2_TABLES = [
    "attendee",
    "star",
    "rubric",
    "rubric_criterion",
    "rubric_version",
    "rubric_version_criterion",
    "rubric_test_case",
    "ai_score",
    "ai_criterion_score",
    "review_decision",
    "interview",
    "interview_grade",
    "assessment",
    "job",
  ];

  async function canSelect(table: string): Promise<boolean> {
    const [row] = await sql<{ can: boolean }[]>`select has_table_privilege(${ROLE}, ${`public.${table}`}, 'SELECT') as can`;
    return row!.can;
  }

  afterAll(async () => {
    const [exists] = await sql`select 1 from pg_roles where rolname = ${ROLE}`;
    if (exists) {
      await sql.unsafe(`drop owned by ${ROLE}`);
      await sql.unsafe(`drop role ${ROLE}`);
    }
  });

  it("can select every Phase 2 table after 0008's grant, and still not integration_secret", async () => {
    await sql.unsafe(`create role ${ROLE} nologin`);
    for (const table of PHASE2_TABLES) expect(await canSelect(table)).toBe(false);

    const grants = readFileSync("drizzle/0008_phase2_triggers_and_grants.sql", "utf8")
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes("tidepool_readonly"));
    expect(grants).toHaveLength(1);
    await sql.unsafe(grants[0]!.replaceAll("tidepool_readonly", ROLE));

    for (const table of PHASE2_TABLES) expect(await canSelect(table), table).toBe(true);
    expect(await canSelect("integration_secret")).toBe(false);
    // The grant reads only; nothing else came with it.
    const [write] = await sql<{ can: boolean }[]>`select has_table_privilege(${ROLE}, 'public.review_decision', 'INSERT, UPDATE, DELETE') as can`;
    expect(write!.can).toBe(false);
  });

  it("is a no-op when the role does not exist", async () => {
    const grants = readFileSync("drizzle/0008_phase2_triggers_and_grants.sql", "utf8")
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes("tidepool_readonly"));
    await sql.unsafe(grants[0]!.replaceAll("tidepool_readonly", `${ROLE}_missing`));
  });
});
