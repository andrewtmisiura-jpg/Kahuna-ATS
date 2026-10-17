// Errors the scoring code throws on purpose, with messages safe to log and store:
// ids, status codes and plain words, never an answer, a name or the key.

export type ScorerErrorKind =
  // Worth trying again in a few minutes: a timeout, a dropped connection, 429 or a 5xx.
  | "retryable"
  // A retry in minutes will not fix it: no key, a key the API refuses, a model the
  // account cannot use, a request the API rejects. The job runner puts the job back
  // without spending an attempt, pauses scoring for the rest of the pass and alerts, so
  // one bad setting never burns through the queue.
  | "unavailable";

// Thrown by a Scorer for an error worth retrying later (the job runner decides); a
// result to store as not scored is returned instead (types.ts).
export class ScorerError extends Error {
  constructor(
    readonly kind: ScorerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ScorerError";
  }
}

export type ScoringRequestErrorCode = "application_not_found" | "not_submitted" | "no_rubric" | "rubric_not_published" | "scoring_off";

// A staff request the scoring service refuses (a re-score of a role with scoring off).
export class ScoringRequestError extends Error {
  constructor(
    readonly code: ScoringRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScoringRequestError";
  }
}
