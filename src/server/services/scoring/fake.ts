import { OVERALL_SCORE_FORMULA_VERSION } from "./engine";
import type { CriterionScore, ScoreResult, Scorer } from "./types";

// A deterministic stand-in for the model (provider.ts uses it everywhere but production,
// and tests pass it directly). It calls nothing and reads only the input it is given:
// every criterion is graded 3 unless one of its answers carries a marker.
//   [score:N]   that criterion is graded N (1 to 5); the first marker among its answers wins
//   [flag:key]  adds the flag when the rubric allows it
//   [fail]      the result is failed, as if the call had errored
//   [invalid]   the result is invalid_output, as if the reply had broken the schema

export const FAKE_MODEL_ID = "fake-scorer";
export const FAKE_PROMPT_VERSION = `fake-1/${OVERALL_SCORE_FORMULA_VERSION}`;

const SCORE_MARKER = /\[score:([1-5])\]/;
const FLAG_MARKER = /\[flag:([a-z0-9_]+)\]/g;

export const fakeScorer: Scorer = {
  async score(rubric, input): Promise<ScoreResult> {
    const texts = input.answers.map((a) => a.answer);
    const failure = { modelId: FAKE_MODEL_ID, promptVersion: FAKE_PROMPT_VERSION };
    if (texts.some((text) => text.includes("[fail]"))) {
      return { status: "failed", error: "Fake scorer: an answer asked for a failed call.", rawOutput: null, ...failure };
    }
    if (texts.some((text) => text.includes("[invalid]"))) {
      return { status: "invalid_output", error: "Fake scorer: an answer asked for a reply that breaks the schema.", rawOutput: "not JSON", ...failure };
    }

    const criteria: CriterionScore[] = rubric.criteria.map((criterion) => {
      const marker = input.answers
        .filter((a) => a.criterionKey === criterion.key)
        .map((a) => SCORE_MARKER.exec(a.answer))
        .find((match) => match !== null);
      const score = marker ? Number(marker[1]) : 3;
      const rationale = marker
        ? `Fake scorer, no model was called: graded ${score} from a [score:${score}] marker in the answer.`
        : "Fake scorer, no model was called: graded 3 because no answer carried a marker.";
      return { criterionKey: criterion.key, score, rationale };
    });
    const allowed = new Set(rubric.allowedFlags.map((flag) => flag.key));
    const flags = [...new Set(texts.flatMap((text) => [...text.matchAll(FLAG_MARKER)].map((match) => match[1]!)))].filter((key) =>
      allowed.has(key),
    );

    return {
      status: "succeeded",
      modelId: FAKE_MODEL_ID,
      promptVersion: FAKE_PROMPT_VERSION,
      criteria,
      overallRationale: "Fake scorer, no model was called: every criterion is graded 3 unless an answer carries a [score:N] marker.",
      flags,
      overallScore: null,
      inputTokens: null,
      outputTokens: null,
      rawOutput: { fake: true, criteria, flags },
    };
  },
};
