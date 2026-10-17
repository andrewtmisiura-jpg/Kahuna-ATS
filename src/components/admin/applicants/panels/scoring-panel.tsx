import { Badge } from "@/components/ui/badge";
import { db } from "@/db";
import { loadScoringPanel, type ScoringPanelData, type ScoringPanelScore } from "@/server/services/scoring/panel";
import { REFUSAL_ERROR } from "@/server/services/scoring/types";
import { formatDateTime } from "../format";
import { Section } from "../section";
import { RescoreButton } from "./scoring-rescore-button";
import type { ProfilePanelProps } from "./types";

// The AI score (Phase 2, scoring): the 1 to 100 number with each criterion's 1 to 5 grade
// and rationale, the overall rationale, the flags and the rubric version beside it, or a
// plain "not scored" line, never a low number. Only in visible mode: hidden mode shows
// the score nowhere outside Settings > AI scoring, and a score made while hidden stays
// hidden. Everyone who can open the profile sees it; only Admins re-score and see the
// protected-trait keyword chips.

export const SORTING_AID_LINE = "A sorting aid only. It never moves, rejects or messages anyone.";

export async function ScoringPanel({ applicationId, user }: ProfilePanelProps) {
  const data = await loadScoringPanel(db, applicationId);
  if (!data) return null;
  const isAdmin = user.role === "admin";
  const score = data.current?.status === "succeeded" && !data.current.hiddenFromReviewers ? data.current : null;

  return (
    <Section title="AI score">
      {score ? <ScoreView score={score} isAdmin={isAdmin} /> : <p>{notScoredLine(data)}</p>}
      {score && data.pending ? <p className="mt-2 text-xs text-muted-foreground">A new score is on its way.</p> : null}
      {score && data.missingAnswers && score.rubricVersion !== data.publishedVersion ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Rubric v{data.publishedVersion} reads questions this application doesn&apos;t answer, so this score is from v{score.rubricVersion}.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">{SORTING_AID_LINE}</p>
      {isAdmin && data.publishedVersion !== null ? <RescoreButton applicationId={applicationId} queued={data.pending} /> : null}
    </Section>
  );
}

function ScoreView({ score, isAdmin }: { score: ScoringPanelScore; isAdmin: boolean }) {
  return (
    <div>
      <p className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tabular-nums">{score.overallScore}</span>
        <span className="text-sm text-muted-foreground">out of 100</span>
      </p>
      <ul className="mt-3 grid gap-2">
        {score.criteria.map((criterion) => (
          <li key={criterion.key}>
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{criterion.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{criterion.score} of 5</span>
            </p>
            {criterion.rationale ? <p className="text-muted-foreground">{criterion.rationale}</p> : null}
          </li>
        ))}
      </ul>
      {score.rationale ? <p className="mt-3">{score.rationale}</p> : null}
      {score.flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {score.flags.map((flag) => (
            <Badge key={flag.key} variant="outline">
              {flag.label}
            </Badge>
          ))}
        </div>
      ) : null}
      {isAdmin && score.keywordHits.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Check the rationale, it mentions:</span>
          {score.keywordHits.map((word) => (
            <Badge key={word} variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-200">
              {word}
            </Badge>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Rubric v{score.rubricVersion}
        {score.completedAt ? `, scored ${formatDateTime(score.completedAt)}` : ""}
      </p>
    </div>
  );
}

// Why there is no number, in the order that matters to the reader.
function notScoredLine(data: ScoringPanelData): string {
  const current = data.current;
  if (current?.hiddenFromReviewers) return "Not shown: this was scored while scores were hidden from reviewers. An Admin can re-score to show a new one.";
  if (data.readsNeverSend) return "Not scored: the rubric reads a question that is never sent to the AI. An Admin fixes the rubric in Settings, AI scoring.";
  if (data.missingAnswers) return "Not scored: this application doesn't have answers to the questions the rubric reads.";
  if (data.pending) return "Scoring soon.";
  if (current?.status === "failed") return current.error === REFUSAL_ERROR ? "Not scored: the AI declined to score these answers." : "Not scored: the scoring call failed.";
  if (current?.status === "invalid_output") return "Not scored: the AI's reply didn't fit the rubric.";
  if (data.gaveUp) return "Not scored: scoring failed. An Admin can re-score.";
  if (data.publishedVersion === null) return "Not scored: this role's rubric has no published version yet.";
  return "Scoring soon.";
}
