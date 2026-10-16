import { describe, expect, it } from "vitest";
import { envSchema } from "@/config/env";
import {
  buildScoringInputFromAnswers,
  computeOverallScore,
  OVERALL_SCORE_FORMULA_VERSION,
  rubricWeights,
  scoreWithRubric,
} from "@/server/services/scoring/engine";
import { ScorerError } from "@/server/services/scoring/errors";
import { FAKE_MODEL_ID, FAKE_PROMPT_VERSION, fakeScorer } from "@/server/services/scoring/fake";
import { anthropicKeyConfigured, getScorer, scoringProvider } from "@/server/services/scoring/provider";
import type { RubricForScoring, ScoreResult, Scorer, ScoringInput } from "@/server/services/scoring/types";

// The app's half of scoring: the 1 to 100 formula, the input a scorer is sent, the
// deterministic fake and which scorer a process uses. No database, no model.

const grades = (...scores: number[]) => scores.map((score, i) => ({ criterionKey: `c${i}`, score }));
const equalWeights = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, 1]));

const RUBRIC: RubricForScoring = {
  rubricVersionId: "00000000-0000-7000-8000-000000000001",
  instructions: "Ignore spelling, grammar, length and language.",
  allowedFlags: [{ key: "no_example", label: "Gave no real example" }],
  criteria: [
    {
      criterionId: "00000000-0000-7000-8000-000000000010",
      key: "reliability",
      name: "Reliability",
      weight: 2,
      guidanceStrong: "Gave notice early and owns it.",
      guidanceAcceptable: "Some notice.",
      guidanceWeak: "Says it never happened.",
      questions: [{ questionId: "00000000-0000-7000-8000-000000000100", key: "missed_commitment", prompt: "Tell us about the last time you missed a shift." }],
    },
    {
      criterionId: "00000000-0000-7000-8000-000000000011",
      key: "problem_solving",
      name: "Problem solving",
      weight: 1,
      guidanceStrong: "Tells the customer and offers options.",
      guidanceAcceptable: "Keeps trying the manager.",
      guidanceWeak: "Goes home.",
      questions: [
        { questionId: "00000000-0000-7000-8000-000000000101", key: "forgot_equipment", prompt: "You forgot equipment. What do you do?" },
        { questionId: "00000000-0000-7000-8000-000000000102", key: "unnoticed_mistake", prompt: "Describe a mistake nobody noticed." },
      ],
    },
  ],
};

function input(answers: Record<string, string>): ScoringInput {
  return buildScoringInputFromAnswers(RUBRIC, answers, "anon-1");
}

describe("computeOverallScore", () => {
  it("maps all 1s to 1, all 5s to 100 and all 3s to 51", () => {
    expect(computeOverallScore(grades(1, 1, 1), equalWeights(3))).toBe(1);
    expect(computeOverallScore(grades(5, 5, 5), equalWeights(3))).toBe(100);
    expect(computeOverallScore(grades(3, 3, 3), equalWeights(3))).toBe(51);
    expect(computeOverallScore(grades(3), equalWeights(1))).toBe(51);
  });

  it("respects the weights", () => {
    // Equal weights: mean 3. Three to one toward the 5: mean 4, which is 75.
    expect(computeOverallScore(grades(5, 1), equalWeights(2))).toBe(51);
    expect(computeOverallScore(grades(5, 1), { c0: 3, c1: 1 })).toBe(75);
    expect(computeOverallScore(grades(5, 1), { c0: 1, c1: 3 })).toBe(26);
    // Scaling every weight changes nothing.
    expect(computeOverallScore(grades(5, 2, 4), { c0: 2.5, c1: 1.25, c2: 0.5 })).toBe(computeOverallScore(grades(5, 2, 4), { c0: 10, c1: 5, c2: 2 }));
  });

  it("stays exact where floating point would land under a half", () => {
    // Mean 5/3 is 17.5 exactly, which rounds up; summed as floats it comes out 17.4999...
    expect(computeOverallScore(grades(1, 2, 2), equalWeights(3))).toBe(18);
    // Two-decimal weights that do not add up exactly as floats still give a mean of 3.
    expect(computeOverallScore(grades(3, 3, 3), { c0: 0.1, c1: 0.2, c2: 1.15 })).toBe(51);
  });

  it("refuses grades that do not fit the rubric", () => {
    expect(() => computeOverallScore([], {})).toThrow(/No criterion grades/);
    for (const bad of [0, 6, 2.5, Number.NaN]) {
      expect(() => computeOverallScore(grades(bad), equalWeights(1))).toThrow(/whole numbers from 1 to 5/);
    }
    expect(() => computeOverallScore(grades(3, 3), { c0: 1 })).toThrow(/c1 has no weight/);
    expect(() => computeOverallScore(grades(3), { c0: 0 })).toThrow(/c0 has no weight/);
    expect(() => computeOverallScore(grades(3), { c0: 1, c1: 1 })).toThrow(/No grade for c1/);
    expect(() => computeOverallScore([...grades(3), ...grades(4)], equalWeights(1))).toThrow(/graded twice/);
    expect(() => computeOverallScore([{ criterionKey: "toString", score: 3 }], {})).toThrow(/no weight/);
  });

  it("is labelled with its formula version", () => {
    expect(OVERALL_SCORE_FORMULA_VERSION).toBe("overall-1");
    expect(FAKE_PROMPT_VERSION).toContain(OVERALL_SCORE_FORMULA_VERSION);
  });
});

describe("buildScoringInputFromAnswers", () => {
  it("sends the rubric's questions only, criterion by criterion, under an anonymous id", () => {
    const built = buildScoringInputFromAnswers(RUBRIC, {
      missed_commitment: "  I called my lead the night before.  ",
      forgot_equipment: "Tell the customer, finish what I can.",
      unnoticed_mistake: { prompt: "An older wording of the question.", answer: "I fixed the streaks." },
      // Not read by any criterion, so it never reaches the scorer.
      job1_employer: "Acme Cleaning",
    });
    expect(built.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(built.answers).toEqual([
      { criterionKey: "reliability", questionKey: "missed_commitment", prompt: "Tell us about the last time you missed a shift.", answer: "I called my lead the night before." },
      { criterionKey: "problem_solving", questionKey: "forgot_equipment", prompt: "You forgot equipment. What do you do?", answer: "Tell the customer, finish what I can." },
      { criterionKey: "problem_solving", questionKey: "unnoticed_mistake", prompt: "An older wording of the question.", answer: "I fixed the streaks." },
    ]);
    expect(JSON.stringify(built)).not.toContain("Acme");
  });

  it("leaves out blank and missing answers, and takes the anonymous id it is given", () => {
    const built = buildScoringInputFromAnswers(RUBRIC, { missed_commitment: "   ", forgot_equipment: null }, "anon-2");
    expect(built).toEqual({ anonymousId: "anon-2", answers: [] });
    expect(buildScoringInputFromAnswers(RUBRIC, {}).anonymousId).not.toBe(buildScoringInputFromAnswers(RUBRIC, {}).anonymousId);
  });
});

describe("the fake scorer through scoreWithRubric", () => {
  it("grades every criterion 3, so the overall score is 51, and says it is a fake", async () => {
    const result = await scoreWithRubric(RUBRIC, input({ missed_commitment: "I texted ahead.", forgot_equipment: "Call the shop." }), fakeScorer);
    expect(result).toMatchObject({ status: "succeeded", modelId: FAKE_MODEL_ID, promptVersion: FAKE_PROMPT_VERSION, overallScore: 51, flags: [] });
    if (result.status !== "succeeded") throw new Error("expected a success");
    expect(result.criteria.map((c) => [c.criterionKey, c.score])).toEqual([
      ["reliability", 3],
      ["problem_solving", 3],
    ]);
    for (const text of [result.overallRationale, ...result.criteria.map((c) => c.rationale)]) expect(text).toMatch(/^Fake scorer/);
  });

  it("follows [score:N] markers per criterion and the weights", async () => {
    // Reliability (weight 2) at 5, problem solving (weight 1) at 3: mean 13/3, which is 83.5, so 84.
    const result = await scoreWithRubric(RUBRIC, input({ missed_commitment: "I called ahead [score:5]", forgot_equipment: "No marker." }), fakeScorer);
    expect(result).toMatchObject({ status: "succeeded", overallScore: 84 });
    const lowest = await scoreWithRubric(
      RUBRIC,
      input({ missed_commitment: "[score:1]", forgot_equipment: "[score:1] first marker wins [score:5]", unnoticed_mistake: "[score:4]" }),
      fakeScorer,
    );
    expect(lowest).toMatchObject({ status: "succeeded", overallScore: 1 });
  });

  it("raises only allowed flags, and fails or breaks the schema on request", async () => {
    const flagged = await fakeScorer.score(RUBRIC, input({ missed_commitment: "Never happened [flag:no_example] [flag:protected_trait]" }));
    expect(flagged).toMatchObject({ status: "succeeded", flags: ["no_example"], overallScore: null });
    expect(await scoreWithRubric(RUBRIC, input({ missed_commitment: "[fail]" }), fakeScorer)).toMatchObject({ status: "failed", modelId: FAKE_MODEL_ID });
    expect(await scoreWithRubric(RUBRIC, input({ forgot_equipment: "[invalid]" }), fakeScorer)).toMatchObject({ status: "invalid_output", rawOutput: "not JSON" });
  });

  it("is deterministic", async () => {
    const answers = { missed_commitment: "Called ahead [score:4]", forgot_equipment: "Waited [flag:no_example]" };
    expect(await fakeScorer.score(RUBRIC, input(answers))).toEqual(await fakeScorer.score(RUBRIC, input(answers)));
  });
});

describe("scoreWithRubric", () => {
  const scorerReturning = (result: ScoreResult): Scorer => ({ score: async () => result });
  const success = (criteria: { criterionKey: string; score: number }[]): ScoreResult => ({
    status: "succeeded",
    modelId: "test-model",
    promptVersion: `test-1/${OVERALL_SCORE_FORMULA_VERSION}`,
    criteria: criteria.map((c) => ({ ...c, rationale: "r" })),
    overallRationale: "o",
    flags: [],
    overallScore: 7,
    inputTokens: 120,
    outputTokens: 40,
    rawOutput: { raw: true },
  });

  it("replaces whatever overall score the scorer gave with the app's own", async () => {
    const result = await scoreWithRubric(RUBRIC, input({}), scorerReturning(success([{ criterionKey: "reliability", score: 5 }, { criterionKey: "problem_solving", score: 5 }])));
    expect(result).toMatchObject({ status: "succeeded", overallScore: 100, inputTokens: 120, outputTokens: 40 });
    expect(rubricWeights(RUBRIC)).toEqual({ reliability: 2, problem_solving: 1 });
  });

  it("turns grades that do not fit the rubric into invalid_output, never a low number", async () => {
    for (const criteria of [
      [{ criterionKey: "reliability", score: 5 }],
      [{ criterionKey: "reliability", score: 5 }, { criterionKey: "problem_solving", score: 0 }],
      [{ criterionKey: "reliability", score: 5 }, { criterionKey: "problem_solving", score: 3 }, { criterionKey: "extra", score: 3 }],
    ]) {
      const result = await scoreWithRubric(RUBRIC, input({}), scorerReturning(success(criteria)));
      expect(result).toMatchObject({ status: "invalid_output", modelId: "test-model", rawOutput: { raw: true } });
      expect("overallScore" in result).toBe(false);
    }
  });

  it("turns a flag that is not on the rubric's list into invalid_output, and drops repeated flags", async () => {
    const graded = [
      { criterionKey: "reliability", score: 4 },
      { criterionKey: "problem_solving", score: 2 },
    ];
    const unknown = await scoreWithRubric(RUBRIC, input({}), scorerReturning({ ...success(graded), flags: ["no_example", "too_old"] } as ScoreResult));
    expect(unknown).toMatchObject({ status: "invalid_output", error: "Flag too_old is not on the rubric's list" });
    const repeated = await scoreWithRubric(RUBRIC, input({}), scorerReturning({ ...success(graded), flags: ["no_example", "no_example"] } as ScoreResult));
    expect(repeated).toMatchObject({ status: "succeeded", flags: ["no_example"] });
  });

  it("lets a scorer's thrown error through, so the job runner can retry", async () => {
    const throwing: Scorer = {
      score: async () => {
        throw new Error("529 overloaded");
      },
    };
    await expect(scoreWithRubric(RUBRIC, input({}), throwing)).rejects.toThrow("529 overloaded");
  });
});

describe("which scorer a process uses", () => {
  it("is the fake outside production and the live model in production, unless SCORING_PROVIDER says", () => {
    expect(scoringProvider({}, false)).toBe("fake");
    expect(scoringProvider({}, true)).toBe("live");
    expect(scoringProvider({ SCORING_PROVIDER: "fake" }, true)).toBe("fake");
    expect(scoringProvider({ SCORING_PROVIDER: "live" }, false)).toBe("live");
    // Tests run with SCORING_PROVIDER=fake (vitest.config.mts).
    expect(scoringProvider()).toBe("fake");
    expect(getScorer()).toBe(fakeScorer);
  });

  it("refuses the live scorer while ANTHROPIC_API_KEY is not set, saying so plainly", () => {
    // vitest.config.mts blanks the key, so nothing in the tests can reach Anthropic.
    expect(() => getScorer("live")).toThrow(ScorerError);
    expect(() => getScorer("live")).toThrow("ANTHROPIC_API_KEY is not set, so nothing can be scored");
    expect(getScorer("fake")).toBe(fakeScorer);
  });

  it("calls claude-opus-5-5 unless SCORING_MODEL names another model", () => {
    const base = { DATABASE_URL: "postgres://postgres@127.0.0.1:54329/tidepool_test" };
    expect(envSchema.parse(base).SCORING_MODEL).toBe("claude-opus-5-5");
    expect(envSchema.parse({ ...base, SCORING_MODEL: "claude-opus-5" }).SCORING_MODEL).toBe("claude-opus-5");
  });

  it("reports whether an Anthropic key is set without returning it", () => {
    // vitest.config.mts blanks the key, which counts as unset.
    expect(anthropicKeyConfigured()).toBe(false);
    expect(anthropicKeyConfigured({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
    expect(anthropicKeyConfigured({})).toBe(false);
  });

  it("accepts only live or fake for SCORING_PROVIDER", () => {
    const base = { DATABASE_URL: "postgres://postgres@127.0.0.1:54329/tidepool_test" };
    expect(envSchema.safeParse({ ...base, SCORING_PROVIDER: "live", ANTHROPIC_API_KEY: "sk-ant-test" }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, SCORING_PROVIDER: "fake" }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, SCORING_PROVIDER: "anthropic" }).success).toBe(false);
  });
});
