import type { RubricForScoring, ScoredResult, Scorer, ScoringAnswer, ScoringInput } from "./types";

// The app's half of scoring (PLAN.md, "The 1 to 100 score"; DATA_MODEL.md, ai_score).
// The model grades each criterion 1 to 5; the app combines the grades with the rubric
// version's weights into the 1 to 100 overall score, so the number is reproducible and
// a weight-only change can re-score from stored ai_criterion_score rows without a call.
// Nothing here reads the database or Node-only modules, so a screen may import it too.

// Recorded in ai_score.prompt_version beside the prompt, so a formula change shows.
export const OVERALL_SCORE_FORMULA_VERSION = "overall-1";

// round(1 + 99 * (weighted mean of the 1 to 5 grades - 1) / 4): every criterion at 1
// gives 1, at 3 gives 51 and at 5 gives 100. The grades and the weights must name the
// same criteria; anything else, or a grade that is not a whole number from 1 to 5,
// throws, because a malformed result must never become a low number.
export function computeOverallScore(
  criteria: readonly { criterionKey: string; score: number }[],
  weights: Readonly<Record<string, number>>,
): number {
  if (criteria.length === 0) throw new Error("No criterion grades to combine");
  // Weights are numeric(5,2), so the sums run in whole hundredths: the mean stays exact
  // and a mean of exactly 3 gives 51, never 50 from a float landing under the half.
  let weightSum = 0;
  let weightedSum = 0;
  const graded = new Set<string>();
  for (const { criterionKey, score } of criteria) {
    if (graded.has(criterionKey)) throw new Error(`Criterion ${criterionKey} is graded twice`);
    graded.add(criterionKey);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error(`Criterion ${criterionKey} was graded ${score}; grades are whole numbers from 1 to 5`);
    }
    const weight = Object.hasOwn(weights, criterionKey) ? Math.round(weights[criterionKey]! * 100) : 0;
    if (!Number.isFinite(weight) || weight < 1) throw new Error(`Criterion ${criterionKey} has no weight above zero`);
    weightSum += weight;
    weightedSum += weight * score;
  }
  const ungraded = Object.keys(weights).filter((key) => !graded.has(key));
  if (ungraded.length > 0) throw new Error(`No grade for ${ungraded.join(", ")}`);
  // 99 * (mean - 1) / 4 as a fraction of whole numbers, rounded half up.
  const numerator = 99 * (weightedSum - weightSum);
  const denominator = 4 * weightSum;
  return 1 + Math.floor((2 * numerator + denominator) / (2 * denominator));
}

// Each criterion key's weight, the second argument of computeOverallScore.
export function rubricWeights(rubric: RubricForScoring): Record<string, number> {
  return Object.fromEntries(rubric.criteria.map((criterion) => [criterion.key, criterion.weight]));
}

// One answer as the scoring service hands it over: the text, or the text with the prompt
// the applicant saw when that differs from the rubric's current wording.
export type AnswerForScoring = string | { prompt: string; answer: string };
export type AnswersByQuestionKey = Readonly<Record<string, AnswerForScoring | null | undefined>>;

// The input a scorer is sent: for each criterion in order, the answers to the questions
// it reads, under a fresh anonymous id. Only the rubric's own questions are read, so
// nothing else in answersByQuestionKey can reach the model; blank answers are left out.
// Basic for now: names or numbers typed into an answer are not redacted yet.
export function buildScoringInputFromAnswers(
  rubric: RubricForScoring,
  answersByQuestionKey: AnswersByQuestionKey,
  anonymousId: string = crypto.randomUUID(),
): ScoringInput {
  const answers: ScoringAnswer[] = [];
  for (const criterion of rubric.criteria) {
    for (const question of criterion.questions) {
      const given = Object.hasOwn(answersByQuestionKey, question.key) ? answersByQuestionKey[question.key] : null;
      if (given === null || given === undefined) continue;
      const { prompt, answer } = typeof given === "string" ? { prompt: question.prompt, answer: given } : given;
      if (!answer.trim()) continue;
      answers.push({ criterionKey: criterion.key, questionKey: question.key, prompt, answer: answer.trim() });
    }
  }
  return { anonymousId, answers };
}

// Runs one scorer on one input and puts the app's overall score on a success. A success
// whose grades do not fit the rubric (a criterion missing, unknown or graded twice, a
// grade outside 1 to 5) comes back as invalid_output. A scorer that throws throws here
// too, so the job runner can retry. Thin for now: the scoring build adds the flag and
// keyword checks.
export async function scoreWithRubric(rubric: RubricForScoring, input: ScoringInput, scorer: Scorer): Promise<ScoredResult> {
  const result = await scorer.score(rubric, input);
  if (result.status !== "succeeded") return result;
  try {
    return { ...result, overallScore: computeOverallScore(result.criteria, rubricWeights(rubric)) };
  } catch (error) {
    return {
      status: "invalid_output",
      error: error instanceof Error ? error.message : String(error),
      modelId: result.modelId,
      promptVersion: result.promptVersion,
      rawOutput: result.rawOutput,
    };
  }
}
