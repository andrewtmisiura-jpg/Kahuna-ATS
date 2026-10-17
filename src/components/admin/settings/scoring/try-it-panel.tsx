"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/admin/questions/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { archiveTestCaseAction, tryRubricAction } from "@/server/actions/admin/rubrics";
import type { TestCaseView, TryItGroup, TryItResult } from "@/server/services/scoring/test-cases";
import { Notice } from "../fields";
import { groupLabel, plural, VARIANT_LABELS } from "./format";
import { TestCaseDialog, type TestCaseDialogMode } from "./test-case-dialog";

// Try it: scores one rubric version (the draft, else the published one) against every
// active sample, three calls at a time, with the scorer real applications get. Results
// sit side by side per group with the group's spread; nothing is saved and nothing here
// is needed to publish. Below them, the samples themselves, added, edited and archived here.

export function TryItPanel({
  roleId,
  rubricId,
  target,
  questions,
  testCases,
  keyMissingMessage,
  standIn,
}: {
  roleId: string;
  rubricId: string | null;
  // The version Try it scores; null while the role has no rubric version at all.
  target: { id: string; version: number; status: "draft" | "published" | "retired" } | null;
  // The questions that version reads, for the sample form.
  questions: { key: string; prompt: string }[];
  testCases: TestCaseView[];
  // Set when the live scorer has no API key, in plain words.
  keyMissingMessage: string | null;
  // The deterministic stand-in scorer answers here instead of the AI.
  standIn: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<Extract<TryItResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TestCaseDialogMode | null>(null);
  const [archiving, setArchiving] = useState<TestCaseView | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const outcome = await tryRubricAction({ roleId, rubricVersionId: target.id });
      if (!outcome.ok) {
        setResult(null);
        setError(outcome.message);
      } else if (!outcome.data.ok) {
        setResult(null);
        setError(outcome.data.message);
      } else {
        setResult(outcome.data);
      }
    });
  }

  const groups = [...new Set(testCases.map((testCase) => testCase.groupKey))];
  const which = target ? `${target.status === "draft" ? "draft" : "published"} version ${target.version}` : "the rubric";
  // Answers in the order the rubric reads the questions; any it no longer reads go last.
  const order = (key: string) => {
    const index = questions.findIndex((question) => question.key === key);
    return index < 0 ? questions.length : index;
  };
  const inOrder = (answers: Record<string, string>) => Object.entries(answers).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Try it</CardTitle>
        <CardDescription>
          Scores the {which} against every sample below, three at a time, with the same scorer and rules as real applications. Nothing is saved, and
          publishing never needs a passing run.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {keyMissingMessage ? <Notice tone="warning">{keyMissingMessage}</Notice> : null}
        {standIn && !keyMissingMessage ? (
          <Notice>Here the stand-in scorer answers instead of the AI: it grades every criterion 3 unless a sample carries a [score:N] marker.</Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={run} disabled={!target || pending || Boolean(keyMissingMessage) || testCases.length === 0} className="h-11 sm:h-9">
            {pending ? "Scoring..." : target ? `Try it on version ${target.version}` : "Try it"}
          </Button>
          {result ? (
            <span className="text-xs text-muted-foreground">
              Version {result.version}, {plural(result.groups.reduce((n, group) => n + group.results.length, 0), "sample")} scored. Not saved.
            </span>
          ) : null}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {result ? <TryItResults groups={result.groups} /> : null}

        <section className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Samples</h3>
              <p className="text-xs text-muted-foreground">
                Made-up answers, never an applicant&apos;s. Write one answer three ways in a group (standard, broken English, short): their scores
                should land within a few points.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" className="h-11 sm:h-8" onClick={() => setDialog({ kind: "add" })} disabled={!rubricId}>
              <Plus /> Add a sample
            </Button>
          </div>
          {testCases.length === 0 ? <p className="text-sm text-muted-foreground">No samples yet.</p> : null}
          {groups.map((group) => (
            <div key={group} className="grid gap-2">
              <h4 className="text-sm font-medium">{groupLabel(group)}</h4>
              <ul className="divide-y rounded-md border">
                {testCases
                  .filter((testCase) => testCase.groupKey === group)
                  .map((testCase) => (
                    <li key={testCase.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 grid gap-1 text-sm">
                        <Badge variant="outline">{VARIANT_LABELS[testCase.variant]}</Badge>
                        {inOrder(testCase.answers).map(([key, answer]) => (
                          <p key={key} className="text-xs">
                            <span className="font-mono text-muted-foreground">{key}</span> {answer.length > 140 ? `${answer.slice(0, 140)}...` : answer}
                          </p>
                        ))}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button type="button" variant="outline" size="sm" className="h-11 sm:h-8" onClick={() => setDialog({ kind: "edit", testCase })}>
                          <Pencil /> Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11 sm:h-8"
                          aria-label={`Archive the ${VARIANT_LABELS[testCase.variant]} sample in ${groupLabel(group)}`}
                          onClick={() => setArchiving(testCase)}
                        >
                          <Trash2 /> Archive
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
      </CardContent>

      {rubricId ? (
        <TestCaseDialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
              router.refresh();
            }
          }}
          roleId={roleId}
          rubricId={rubricId}
          mode={dialog}
          questions={questions}
          groups={groups}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setArchiving(null);
            router.refresh();
          }
        }}
        title="Archive this sample?"
        description="It drops out of Try it. Nothing is deleted."
        confirmLabel="Archive sample"
        onConfirm={async () => {
          if (!archiving) return undefined;
          const outcome = await archiveTestCaseAction({ roleId, testCaseId: archiving.id });
          return outcome.ok ? undefined : outcome.message;
        }}
      />
    </Card>
  );
}

function TryItResults({ groups }: { groups: TryItGroup[] }) {
  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <section key={group.groupKey} aria-label={`Results for ${groupLabel(group.groupKey)}`} className="grid gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-medium">{groupLabel(group.groupKey)}</h4>
            <span className={cn("text-sm tabular-nums", group.wide ? "font-medium text-amber-800 dark:text-amber-200" : "text-muted-foreground")}>
              {group.spread === null ? "Spread needs two scores" : `Spread: ${plural(group.spread, "point")}`}
            </span>
          </div>
          {group.wide ? (
            <Notice tone="warning">
              These samples say the same thing but scored more than 10 points apart. Check the guidance and instructions: the AI may be grading the
              writing rather than the behavior.
            </Notice>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            {group.results.map((result) => (
              <div key={result.testCaseId} className="grid content-start gap-1 rounded-md bg-muted/40 p-2 text-sm">
                <p className="text-xs font-medium text-muted-foreground">{VARIANT_LABELS[result.variant]}</p>
                {result.overallScore !== null ? (
                  <p>
                    <span className="text-2xl font-semibold tabular-nums">{result.overallScore}</span>
                    <span className="text-xs text-muted-foreground"> out of 100</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">{result.message}</p>
                )}
                {result.criteria.length > 0 ? (
                  <ul className="grid gap-0.5 text-xs">
                    {result.criteria.map((criterion) => (
                      <li key={criterion.key} className="flex justify-between gap-2">
                        <span>{criterion.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{criterion.score} of 5</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {result.flags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {result.flags.map((flag) => (
                      <Badge key={flag.key} variant="outline">
                        {flag.label}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {result.keywordHits.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="text-muted-foreground">Check the rationale, it mentions:</span>
                    {result.keywordHits.map((word) => (
                      <Badge key={word} variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-200">
                        {word}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {result.overallRationale ? (
                  <details className="text-xs">
                    <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-0">Why</summary>
                    <p className="mt-1">{result.overallRationale}</p>
                    {result.criteria.map((criterion) => (
                      <p key={criterion.key} className="mt-1 text-muted-foreground">
                        {criterion.name}: {criterion.rationale}
                      </p>
                    ))}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
