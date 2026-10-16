import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiScore, auditLog, job, rubricTestCase } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { ScorerError } from "@/server/services/scoring/errors";
import { fakeScorer } from "@/server/services/scoring/fake";
import { ensureRubricDraft, RubricError, saveRubricDraft } from "@/server/services/scoring/rubrics";
import {
  addTestCase,
  archiveTestCase,
  listTestCases,
  mapWithConcurrency,
  NO_KEY_MESSAGE,
  scoreSpread,
  SPREAD_WARNING_POINTS,
  tryRubricVersion,
  updateTestCase,
  type TryItCaseResult,
} from "@/server/services/scoring/test-cases";
import type { Scorer } from "@/server/services/scoring/types";
import { withRollback } from "./helpers/db";
import { loadAdminId, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createRubricRole, criterionInput, type RubricRoleFixture } from "./helpers/rubrics";

// The rubric editor's samples and Try it (scoring/test-cases.ts), run with the fake scorer
// or scorers made to fail. Nothing Try it does is stored. Each case builds its own role in
// a rolled-back transaction.

let adminId: string;
let actor: ReturnType<typeof staffActor>;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
  actor = staffActor(adminId);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// A draft where reliability (weight 2) reads the commitment answer and integrity (weight 1)
// the mistake answer, with one allowed flag.
async function draftRubric(tx: Tx, role: RubricRoleFixture) {
  const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
  await saveRubricDraft(tx, {
    rubricVersionId: draft.id,
    instructions: "Grade the behavior.",
    allowedFlags: [{ key: "blames_others", label: "Blames others for their own mistake" }],
    criteria: [
      criterionInput("Reliability", [role.questions.commitment], { weight: 2 }),
      criterionInput("Integrity", [role.questions.mistake], { weight: 1 }),
    ],
    actor,
  });
  return draft;
}

const sample = (commitment: string, mistake: string) => ({ commitment, mistake });

async function expectRubricError(run: Promise<unknown>, code: RubricError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof RubricError && error.code === code);
}

describe("samples", () => {
  it("adds, edits and archives samples, keeping only non-blank answers, and audits each", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      const added = await addTestCase(tx, {
        rubricId: draft.rubricId,
        groupKey: "Solid answers",
        variant: "broken_english",
        answers: { commitment: " I call my boss early. ", mistake: "  " },
        actor,
      });
      expect(added).toMatchObject({ groupKey: "solid_answers", variant: "broken_english", answers: { commitment: "I call my boss early." } });

      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "solid_answers", variant: "standard", answers: sample("I called my lead early.", "I fixed it."), actor });
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "Another group", variant: "short", answers: sample("Called ahead.", "Fixed it."), actor });
      // By group, then standard before broken English.
      expect((await listTestCases(tx, draft.rubricId)).map((c) => [c.groupKey, c.variant])).toEqual([
        ["another_group", "short"],
        ["solid_answers", "standard"],
        ["solid_answers", "broken_english"],
      ]);

      const edited = await updateTestCase(tx, { testCaseId: added.id, groupKey: "solid_answers", variant: "short", answers: sample("Called early.", "Fixed it."), actor });
      expect(edited).toMatchObject({ variant: "short", answers: { commitment: "Called early.", mistake: "Fixed it." } });
      await archiveTestCase(tx, { testCaseId: added.id, actor });
      expect((await listTestCases(tx, draft.rubricId)).map((c) => c.id)).not.toContain(added.id);
      const [row] = await tx.select().from(rubricTestCase).where(eq(rubricTestCase.id, added.id));
      expect(row!.archivedAt).not.toBeNull();
      await expectRubricError(archiveTestCase(tx, { testCaseId: added.id, actor }), "test_case_not_found");

      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityId, added.id));
      expect(entries.map((e) => e.action)).toEqual(["rubric_test_case.create", "rubric_test_case.update", "rubric_test_case.archive"]);
      // The audit names the questions answered, never the text.
      expect(JSON.stringify(entries.map((e) => e.changes))).not.toContain("Called early");
    });
  });

  it("refuses a sample that could never be scored", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      const add = (patch: { groupKey?: string; variant?: string; answers?: Record<string, string> }) =>
        addTestCase(tx, { rubricId: draft.rubricId, groupKey: "solid", variant: "standard", answers: sample("Called.", "Fixed."), actor, ...patch });
      await expectRubricError(add({ groupKey: " !! " }), "group_required");
      await expectRubricError(add({ variant: "fancy" }), "invalid_variant");
      await expectRubricError(add({ answers: { commitment: " ", mistake: "" } }), "answers_required");
      await expectRubricError(add({ answers: { age_18_plus: "Yes" } }), "answer_not_on_role");
      await expectRubricError(add({ answers: { employer_name: "A roofing company" } }), "question_never_send");
      expect(await listTestCases(tx, draft.rubricId)).toEqual([]);
    });
  });
});

describe("Try it", () => {
  it("scores every active sample against the draft and gives each group's spread, flagging one over 10 points", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      const cases: [string, string, string, string][] = [
        // Every criterion graded 3 by the fake scorer: 51 each, no spread.
        ["even", "standard", "I called my lead the night before.", "I told the owner right away."],
        ["even", "broken_english", "I call my lead night before.", "I tell owner right away."],
        ["even", "short", "Called ahead.", "Told the owner."],
        // 75 (4 and 4) and 67 (4 and 3): 8 points apart, within the warning.
        ["close", "standard", "I called ahead [score:4]", "I owned up [score:4]"],
        ["close", "short", "Called ahead [score:4]", "Owned up [score:3]"],
        // 100 against 51: far apart.
        ["wide", "standard", "Called the night before [score:5]", "Fixed it on my own time [score:5] [flag:blames_others]"],
        ["wide", "short", "Called.", "Fixed."],
      ];
      for (const [groupKey, variant, commitment, mistake] of cases) {
        await addTestCase(tx, { rubricId: draft.rubricId, groupKey, variant, answers: sample(commitment, mistake), actor });
      }
      // Archived samples are left out.
      const archived = await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "even", variant: "other", answers: sample("[score:1]", "[score:1]"), actor });
      await archiveTestCase(tx, { testCaseId: archived.id, actor });

      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: fakeScorer });
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ rubricVersionId: draft.id, version: 1, status: "draft" });
      const view = Object.fromEntries(result.groups.map((g) => [g.groupKey, { scores: g.results.map((r) => r.overallScore), spread: g.spread, wide: g.wide }]));
      expect(view).toEqual({
        close: { scores: [75, 67], spread: 8, wide: false },
        even: { scores: [51, 51, 51], spread: 0, wide: false },
        wide: { scores: [100, 51], spread: 49, wide: true },
      });

      const top = result.groups.find((g) => g.groupKey === "wide")!.results[0]!;
      expect(top.outcome).toBe("scored");
      expect(top.criteria.map((c) => [c.key, c.name, c.score])).toEqual([
        ["reliability", "Reliability", 5],
        ["integrity", "Integrity", 5],
      ]);
      expect(top.flags).toEqual([{ key: "blames_others", label: "Blames others for their own mistake" }]);
      expect(top.overallRationale).toMatch(/Fake scorer/);
      expect(top.keywordHits).toEqual([]);
    });
  });

  it("stores nothing: no score, no job and no audit row", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "even", variant: "standard", answers: sample("Called.", "Fixed."), actor });
      const counts = async () => ({
        scores: (await tx.select({ n: count() }).from(aiScore))[0]!.n,
        jobs: (await tx.select({ n: count() }).from(job))[0]!.n,
        audits: (await tx.select({ n: count() }).from(auditLog))[0]!.n,
      });
      const before = await counts();
      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: fakeScorer });
      expect(result.ok).toBe(true);
      expect(await counts()).toEqual(before);
    });
  });

  it("sends nothing for a sample that leaves a criterion unanswered", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "partial", variant: "standard", answers: { commitment: "I called ahead." }, actor });
      let calls = 0;
      const counting: Scorer = {
        score: (rubric, input) => {
          calls += 1;
          return fakeScorer.score(rubric, input);
        },
      };
      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: counting });
      if (!result.ok) throw new Error(result.message);
      const only = result.groups[0]!.results[0]!;
      expect(only).toMatchObject({ outcome: "missing_answers", overallScore: null, missingCriteria: ["Integrity"] });
      expect(only.message).toMatch(/No answer for Integrity/);
      expect(calls).toBe(0);
      expect(result.groups[0]!.spread).toBeNull();
    });
  });

  it("shows a failed call, a reply that breaks the rubric and a thrown error as not scored, never a low number", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "broken", variant: "standard", answers: sample("Called. [fail]", "Fixed."), actor });
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "broken", variant: "short", answers: sample("Called. [invalid]", "Fixed."), actor });
      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: fakeScorer });
      if (!result.ok) throw new Error(result.message);
      const [failed, invalid] = result.groups[0]!.results as [TryItCaseResult, TryItCaseResult];
      expect(failed).toMatchObject({ outcome: "not_scored", overallScore: null, message: "Not scored: the scoring call failed." });
      expect(invalid).toMatchObject({ outcome: "not_scored", overallScore: null, message: "Not scored: the AI's reply didn't fit the rubric." });

      const overloaded: Scorer = {
        score: async () => {
          throw new ScorerError("retryable", "Anthropic answered 529 overloaded_error; trying again later");
        },
      };
      const thrown = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: overloaded });
      if (!thrown.ok) throw new Error(thrown.message);
      expect(thrown.groups[0]!.results.map((r) => [r.outcome, r.message])).toEqual([
        ["error", "Anthropic answered 529 overloaded_error; trying again later"],
        ["error", "Anthropic answered 529 overloaded_error; trying again later"],
      ]);

      const buggy: Scorer = {
        score: async () => {
          throw new TypeError("cannot read the answers of undefined");
        },
      };
      const plain = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: buggy });
      if (!plain.ok) throw new Error(plain.message);
      expect(plain.groups[0]!.results[0]!.message).toBe("The scoring call failed. Try again in a few minutes.");
    });
  });

  it("chips a rationale that names a protected trait, as the profile does for Admins", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "chips", variant: "standard", answers: sample("Called.", "Fixed."), actor });
      const careless: Scorer = {
        score: async (rubric, input) => {
          const result = await fakeScorer.score(rubric, input);
          return result.status === "succeeded" ? { ...result, overallRationale: "Seems older and married, but reliable." } : result;
        },
      };
      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: careless });
      if (!result.ok) throw new Error(result.message);
      expect(result.groups[0]!.results[0]!.keywordHits).toEqual(["older", "married"]);
    });
  });

  it("runs at most three calls at a time", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      for (const n of [1, 2, 3, 4, 5, 4, 3]) {
        await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "load", variant: "other", answers: sample(`Called [score:${n}]`, `Fixed [score:${n}]`), actor });
      }
      let running = 0;
      let peak = 0;
      const slow: Scorer = {
        score: async (rubric, input) => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 20));
          running -= 1;
          return fakeScorer.score(rubric, input);
        },
      };
      const result = await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: slow });
      if (!result.ok) throw new Error(result.message);
      expect(peak).toBe(3);
      // Grades of n on both criteria: 1, 26, 51, 75 and 100 for n = 1 to 5.
      expect(result.groups[0]!.results.map((r) => r.overallScore).sort((a, b) => a! - b!)).toEqual([1, 26, 51, 51, 75, 75, 100]);
      expect(result.groups[0]).toMatchObject({ spread: 99, wide: true });
    });
  });

  it("says plainly when the live scorer has no API key, and when there is nothing to try", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await draftRubric(tx, role);
      expect(await tryRubricVersion(tx, { rubricVersionId: draft.id, scorer: fakeScorer })).toMatchObject({ ok: false, reason: "no_cases" });
      await addTestCase(tx, { rubricId: draft.rubricId, groupKey: "even", variant: "standard", answers: sample("Called.", "Fixed."), actor });
      // Tests run with ANTHROPIC_API_KEY blank, so the live scorer is never built or called.
      expect(await tryRubricVersion(tx, { rubricVersionId: draft.id, provider: "live" })).toEqual({ ok: false, reason: "no_key", message: NO_KEY_MESSAGE });
      expect(NO_KEY_MESSAGE).toMatch(/ANTHROPIC_API_KEY/);
      // The process's own provider is the fake one in tests.
      expect((await tryRubricVersion(tx, { rubricVersionId: draft.id })).ok).toBe(true);
    });
  });
});

describe("spread and concurrency helpers", () => {
  it("measures a group's spread once two samples are scored", () => {
    expect(scoreSpread([])).toBeNull();
    expect(scoreSpread([51])).toBeNull();
    expect(scoreSpread([51, null])).toBeNull();
    expect(scoreSpread([51, null, 67])).toBe(16);
    expect(scoreSpread([100, 51, 75])).toBe(49);
    expect(SPREAD_WARNING_POINTS).toBe(10);
  });

  it("maps with a limit and keeps the order", async () => {
    const order: number[] = [];
    const result = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(index);
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40, 0]);
    expect(order).not.toEqual([0, 1, 2, 3]);
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
