import type { RubricFlag, ScoringInputSnapshot } from "@/db/schema";

// The contract between the rubric editor, the scoring job and the scorers (PLAN.md,
// Phase 2; DATA_MODEL.md, rubric_version and ai_score). A Scorer grades each criterion
// of a rubric from 1 to 5 for one anonymous input; the app, never the model, turns
// those grades into the 1 to 100 overall score (engine.ts).

// A rubric version as a scorer reads it: rubric_version, its rubric_version_criterion
// rows in sort order, and the question lineages each criterion reads.
export type RubricForScoring = {
  rubricVersionId: string;
  instructions: string;
  allowedFlags: RubricFlag[];
  criteria: RubricCriterionForScoring[];
};

export type RubricCriterionForScoring = {
  criterionId: string;
  // rubric_criterion.key: stable across versions, and how grades come back.
  key: string;
  name: string;
  // Above zero, at most two decimals (numeric(5,2)).
  weight: number;
  guidanceStrong: string;
  guidanceAcceptable: string;
  guidanceWeak: string;
  // The lineages this criterion reads, never one with ai_never_send.
  questions: { questionId: string; key: string; prompt: string }[];
};

// What a scorer is sent, stored as-is in ai_score.input_snapshot: an anonymous id and
// the answers to the questions the rubric's criteria read. Never a name, phone or email.
export type ScoringInput = ScoringInputSnapshot;
export type ScoringAnswer = ScoringInput["answers"][number];

export type CriterionScore = {
  criterionKey: string;
  // A whole number from 1 to 5.
  score: number;
  rationale: string;
};

export type ScoreSucceeded = {
  status: "succeeded";
  modelId: string;
  // Names the prompt and the overall-score formula (OVERALL_SCORE_FORMULA_VERSION in engine.ts).
  promptVersion: string;
  // One per rubric criterion.
  criteria: CriterionScore[];
  overallRationale: string;
  // Keys from the rubric's allowedFlags only.
  flags: string[];
  // Scorers leave it null; scoreWithRubric always sets it from computeOverallScore.
  overallScore: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rawOutput: unknown;
};

// A call that failed, or output that broke the schema. Stored with the error and shown
// as "not scored", never as a low number.
export type ScoreFailed = {
  status: "failed" | "invalid_output";
  error: string;
  modelId: string;
  promptVersion: string;
  rawOutput: unknown;
};

// ScoreFailed.error when the model declined to grade (stop_reason "refusal"), so the
// profile can say it declined rather than that the call failed.
export const REFUSAL_ERROR = "refusal";

export type ScoreResult = ScoreSucceeded | ScoreFailed;

// What scoreWithRubric returns: a success always carries the app's overall score.
export type ScoredResult = (ScoreSucceeded & { overallScore: number }) | ScoreFailed;

// The live Anthropic scorer and the fake both implement this. A scorer returns failed or
// invalid_output for a result that should be stored as not scored, and throws for an
// error worth retrying (the job runner decides), such as the network or a 5xx; a
// ScorerError (errors.ts) also says whether a retry in minutes can help.
export interface Scorer {
  score(rubric: RubricForScoring, input: ScoringInput): Promise<ScoreResult>;
}
