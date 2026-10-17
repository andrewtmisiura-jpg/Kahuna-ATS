import { Badge } from "@/components/ui/badge";
import type { RubricFlag } from "@/db/schema";
import { weightShare } from "./format";

// A rubric version read-only: each criterion with its weight and share of the score and
// the questions it reads, then the flags, and on request the guidance and instructions.

export type RubricViewCriterion = {
  key: string;
  name: string;
  weight: number;
  guidanceStrong: string;
  guidanceAcceptable: string;
  guidanceWeak: string;
  questionIds: string[];
  meaningChanged: boolean;
};

export function RubricView({
  criteria,
  allowedFlags,
  instructions,
  questionKeys,
  detailed = false,
}: {
  criteria: RubricViewCriterion[];
  allowedFlags: RubricFlag[];
  instructions?: string;
  // question.id to key, for "reads missed_commitment".
  questionKeys: Record<string, string>;
  detailed?: boolean;
}) {
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  return (
    <div className="grid gap-3 text-sm">
      {criteria.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {criteria.map((criterion) => (
            <li key={criterion.key} className="grid gap-1 px-3 py-2">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-medium">
                  {criterion.name} <span className="font-mono text-xs font-normal text-muted-foreground">{criterion.key}</span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  weight {criterion.weight}
                  {weightShare(criterion.weight, total) !== null ? `, ${weightShare(criterion.weight, total)}% of the score` : ""}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Reads {criterion.questionIds.map((id) => questionKeys[id] ?? "a question no longer on this role").join(", ") || "nothing yet"}
                {criterion.meaningChanged ? ". Marked as asking for something different from the version before." : ""}
              </p>
              {detailed ? (
                <dl className="mt-1 grid gap-1 text-xs sm:grid-cols-[6rem_1fr]">
                  <dt className="text-muted-foreground">Strong (5)</dt>
                  <dd>{criterion.guidanceStrong}</dd>
                  <dt className="text-muted-foreground">Acceptable (3)</dt>
                  <dd>{criterion.guidanceAcceptable}</dd>
                  <dt className="text-muted-foreground">Weak (1)</dt>
                  <dd>{criterion.guidanceWeak}</dd>
                </dl>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No criteria yet.</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">Flags:</span>
        {allowedFlags.length > 0 ? (
          allowedFlags.map((flag) => (
            <Badge key={flag.key} variant="outline" title={flag.key}>
              {flag.label}
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
      </div>
      {detailed && instructions ? (
        <div>
          <p className="text-muted-foreground">Instructions for the AI</p>
          <p className="whitespace-pre-line">{instructions}</p>
        </div>
      ) : null}
    </div>
  );
}
