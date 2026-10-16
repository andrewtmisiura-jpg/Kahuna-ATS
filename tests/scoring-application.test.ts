import { and, asc, eq, sql as raw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiCriterionScore, aiScore, application, applicationEvent, message, rubric } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor, SYSTEM_ACTOR } from "@/server/services/actor";
import { transition } from "@/server/services/applications/transition";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { FAKE_MODEL_ID, FAKE_PROMPT_VERSION, fakeScorer } from "@/server/services/scoring/fake";
import { scoreApplication } from "@/server/services/scoring/score-application";
import { NeverSendLineageError } from "@/server/services/scoring/snapshot";
import type { Scorer, ScoringInput } from "@/server/services/scoring/types";
import { withRollback } from "./helpers/db";
import { loadAdminId, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createRubricVersion } from "./helpers/phase2";
import { COMMITMENT_PROMPT, createScoringRole, MISTAKE_PROMPT, submitScoringApplication } from "./helpers/scoring";

// Scoring one application (scoring/score-application.ts): the snapshot it sends, the score
// and criterion grades it writes in one transaction, and what it never touches. Each case
// builds its own role inside a rolled-back transaction (tests/helpers/scoring.ts).

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

// The fake, recording every input it is sent.
function recordingScorer(base: Scorer = fakeScorer): Scorer & { inputs: ScoringInput[] } {
  const inputs: ScoringInput[] = [];
  return {
    inputs,
    score: (rubricForScoring, input) => {
      inputs.push(input);
      return base.score(rubricForScoring, input);
    },
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function scores(tx: Tx, applicationId: string) {
  return tx.select().from(aiScore).where(eq(aiScore.applicationId, applicationId)).orderBy(asc(aiScore.createdAt), asc(aiScore.id));
}

describe("scoreApplication", () => {
  it("sends the anonymous snapshot and writes the 1 to 100 score with one grade per criterion, as the current score", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "I called my lead the night before [score:5]", mistake: "I told the owner." });
      const scorer = recordingScorer();
      const outcome = await scoreApplication(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer });
      // Reliability 5 at weight 2 and integrity 3 at weight 1: a mean of 13/3, which is 83.5, so 84.
      expect(outcome).toMatchObject({ kind: "scored", status: "succeeded", overallScore: 84, keywordHits: [] });

      const [row] = await scores(tx, applicationId);
      expect(row).toMatchObject({
        rubricVersionId: role.published.rubricVersionId,
        status: "succeeded",
        modelId: FAKE_MODEL_ID,
        promptVersion: FAKE_PROMPT_VERSION,
        overallScore: 84,
        isCurrent: true,
        hiddenFromReviewers: false,
        scoredAfterDecision: false,
        requestedByType: "system",
        requestedByUserId: null,
        flags: [],
        keywordHits: [],
        error: null,
      });
      expect(row!.completedAt).toBeInstanceOf(Date);
      expect(row!.rationale).toMatch(/^Fake scorer/);
      // Exactly what the scorer was sent.
      expect(row!.inputSnapshot).toEqual(scorer.inputs[0]);
      expect(row!.inputSnapshot.answers).toEqual([
        { criterionKey: "reliability", questionKey: "commitment", prompt: COMMITMENT_PROMPT, answer: "I called my lead the night before [score:5]" },
        { criterionKey: "integrity", questionKey: "mistake", prompt: MISTAKE_PROMPT, answer: "I told the owner." },
      ]);

      const grades = await tx.select().from(aiCriterionScore).where(eq(aiCriterionScore.aiScoreId, row!.id));
      const byCriterion = new Map(role.published.criteria.map((c) => [c.criterionId, c.key]));
      expect(grades.map((g) => [byCriterion.get(g.criterionId), g.score]).sort()).toEqual([
        ["integrity", 3],
        ["reliability", 5],
      ]);
    });
  });

  it("never sends the person's name, phone or email, even where the answers repeat them", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const who = { firstName: "Rosalind", lastName: "Okonkwo-Baptiste", email: "roz.ob1987@gmail.com", mobile: "+17635550199" };
      const { applicationId } = await submitScoringApplication(
        tx,
        role,
        {
          commitment: "Rosalind here. My truck died, so I texted my boss at 5am from (763) 555-0199 and emailed from roz.ob1987@gmail.com.",
          mistake: "I left a streak and went back. Ask for Okonkwo-Baptiste at 763-555-0199 or ROZ.OB1987@GMAIL.COM.",
          employer_name: "Okonkwo Cleaning Co",
        },
        who,
      );
      const scorer = recordingScorer();
      await scoreApplication(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer });
      const [row] = await scores(tx, applicationId);
      // An anonymous id and the answers, nothing else; the id is random, so the digits
      // below are looked for in the answers.
      expect(Object.keys(row!.inputSnapshot).sort()).toEqual(["anonymousId", "answers"]);
      expect(row!.inputSnapshot.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
      expect([applicationId, role.questions.commitment]).not.toContain(row!.inputSnapshot.anonymousId);
      for (const json of [JSON.stringify(scorer.inputs[0]!.answers), JSON.stringify(row!.inputSnapshot.answers)]) {
        const lower = json.toLowerCase();
        for (const secret of ["rosalind", "okonkwo", "baptiste", "roz.ob1987", "gmail", "@", "555", "0199", applicationId, role.questions.employer_name]) {
          expect(lower).not.toContain(secret.toLowerCase());
        }
        // The never-send question is not read at all.
        expect(lower).not.toContain("employer_name");
        expect(lower).not.toContain("cleaning co");
      }
      expect(row!.inputSnapshot.answers[0]!.answer).toBe("[redacted] here. My truck died, so I texted my boss at 5am from [redacted] and emailed from [redacted].");
    });
  });

  it("stores a failed call and a reply that breaks the schema as not scored, never as a number", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const failed = await submitScoringApplication(tx, role, { commitment: "[fail]", mistake: "Told them." });
      const invalid = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "[invalid]" });
      for (const { applicationId } of [failed, invalid]) {
        await scoreApplication(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer: fakeScorer });
      }
      const [failedRow] = await scores(tx, failed.applicationId);
      expect(failedRow).toMatchObject({ status: "failed", overallScore: null, rationale: null, flags: null, isCurrent: true, error: expect.stringContaining("failed call") });
      const [invalidRow] = await scores(tx, invalid.applicationId);
      expect(invalidRow).toMatchObject({ status: "invalid_output", overallScore: null, rawOutput: "not JSON", isCurrent: true });
      const grades = await tx.select().from(aiCriterionScore).where(raw`${aiCriterionScore.aiScoreId} in (${failedRow!.id}, ${invalidRow!.id})`);
      expect(grades).toEqual([]);
    });
  });

  it("makes the newest score current, hides a hidden-mode score from reviewers and marks a score made after a decision", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "hidden" });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
      const input = { applicationId, rubricVersionId: role.published.rubricVersionId, scorer: fakeScorer };
      await scoreApplication(tx, { ...input, requestedBy: SYSTEM_ACTOR });
      const [first] = await scores(tx, applicationId);
      expect(first).toMatchObject({ isCurrent: true, hiddenFromReviewers: true, scoredAfterDecision: false });

      // A Hold with a current score writes a review decision; a re-score after it is marked.
      const [app] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, applicationId));
      await transition(tx, { action: "hold", applicationId, actor: staffActor(adminId), expectedSeq: app!.eventSeq });
      await tx.update(rubric).set({ scoringMode: "visible" }).where(eq(rubric.id, role.rubricId));
      await scoreApplication(tx, { ...input, requestedBy: staffActor(adminId) });
      const [before, after] = await scores(tx, applicationId);
      expect(before).toMatchObject({ id: first!.id, isCurrent: false });
      expect(after).toMatchObject({ isCurrent: true, hiddenFromReviewers: false, scoredAfterDecision: true, requestedByType: "staff", requestedByUserId: adminId });
    });
  });

  it("sends nothing and writes no score when a criterion has no answer to read", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead." });
      const scorer = recordingScorer();
      const outcome = await scoreApplication(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer });
      expect(outcome).toEqual({ kind: "skipped", reason: "missing_answers" });
      expect(scorer.inputs).toEqual([]);
      expect(await scores(tx, applicationId)).toEqual([]);
    });
  });

  it("refuses a rubric that reads a never-send question before anything is sent", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them.", employer_name: "Acme" });
      const reads = await createRubricVersion(tx, role.rubricId, {
        published: true,
        criteria: [
          { key: "reliability", weight: 2, questionIds: [role.questions.commitment, role.questions.employer_name] },
          { key: "integrity", weight: 1, questionIds: [role.questions.mistake] },
        ],
      });
      const scorer = recordingScorer();
      await expect(scoreApplication(tx, { applicationId, rubricVersionId: reads.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer })).rejects.toThrow(
        NeverSendLineageError,
      );
      expect(scorer.inputs).toEqual([]);
      expect(await scores(tx, applicationId)).toEqual([]);
    });
  });

  it("skips a job for a version no longer published or a role whose scoring is off", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
      const next = await createRubricVersion(tx, role.rubricId, { published: true, criteria: [{ key: "reliability", questionIds: [role.questions.commitment] }] });
      const base = { applicationId, requestedBy: SYSTEM_ACTOR, scorer: fakeScorer };
      expect(await scoreApplication(tx, { ...base, rubricVersionId: role.published.rubricVersionId })).toEqual({ kind: "skipped", reason: "superseded" });
      await tx.update(rubric).set({ scoringMode: "off" }).where(eq(rubric.id, role.rubricId));
      expect(await scoreApplication(tx, { ...base, rubricVersionId: next.rubricVersionId })).toEqual({ kind: "skipped", reason: "scoring_off" });
      expect(await scores(tx, applicationId)).toEqual([]);
    });
  });

  it("writes no event, no message and no stage or status change, and alerts once per score whose rationale names a protected trait", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
      const before = await tx.select().from(application).where(eq(application.id, applicationId));
      const events = await tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId));
      const [{ count: messagesBefore }] = await tx.select({ count: raw<number>`count(*)::int` }).from(message);
      await scoreApplication(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer: fakeScorer });
      expect(await tx.select().from(application).where(eq(application.id, applicationId))).toEqual(before);
      expect(await tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId))).toEqual(events);
      const [{ count: messagesAfter }] = await tx.select({ count: raw<number>`count(*)::int` }).from(message);
      expect(messagesAfter).toBe(messagesBefore);

      // A rationale that names a protected trait: kept, chipped and alerted, once per score.
      const mentions: Scorer = {
        async score(r, input) {
          const result = await fakeScorer.score(r, input);
          if (result.status !== "succeeded") return result;
          return { ...result, overallRationale: "Seems young; mentions kids at home.", criteria: result.criteria.map((c) => ({ ...c, rationale: "Called ahead, says the Family comes first." })) };
        },
      };
      const sink = createSinkProviders();
      const input = { applicationId, rubricVersionId: role.published.rubricVersionId, requestedBy: SYSTEM_ACTOR, scorer: mentions, providers: sink };
      const first = await scoreApplication(tx, input);
      expect(first).toMatchObject({ kind: "scored", keywordHits: ["young", "kids", "family"] });
      const [, flagged] = await scores(tx, applicationId);
      expect(flagged).toMatchObject({ status: "succeeded", keywordHits: ["young", "kids", "family"] });
      await scoreApplication(tx, input);
      const alerts = sink.sent.filter((s) => s.channel === "email" && s.message.subject.includes("protected trait"));
      expect(alerts).toHaveLength(2);
      expect(alerts[0]!.message.body).toContain(flagged!.id);
      expect(alerts[0]!.message.body).toContain("young, kids, family");
      const keys = await tx.select({ key: message.dedupeKey }).from(message).where(and(raw`${message.dedupeKey} like 'alert:keyword_hits:%'`, raw`${message.body} like ${`%${applicationId}%`}`));
      expect(keys).toHaveLength(2);
    });
  });
});
