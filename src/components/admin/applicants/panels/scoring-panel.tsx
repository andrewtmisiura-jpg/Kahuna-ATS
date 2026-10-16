import type { ProfilePanelProps } from "./types";

// The AI score (Phase 2, scoring): the 1 to 100 number with the per-criterion grades,
// the rationale and the rubric version beside it, or "not scored" for a failed or
// invalid result. A score hidden from reviewers never renders. Renders nothing until
// the scoring build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the scoring build fills in
export async function ScoringPanel({ applicationId, user, canAct }: ProfilePanelProps) {
  return null;
}
