"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/admin/questions/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ScoringMode } from "@/db/schema";
import { discardRubricDraftAction, saveRubricDraftAction, type SaveRubricDraftActionInput } from "@/server/actions/admin/rubrics";
import { slugKey } from "@/server/services/forms/keys";
import type { RubricProblem, RubricQuestionOption, RubricVersionView } from "@/server/services/scoring/rubrics";
import { CheckboxField, Field, NativeSelect, Notice, Textarea } from "../fields";
import { weightShare } from "./format";
import { PublishRubricDialog } from "./publish-dialog";

// The draft rubric, edited as a whole and saved in one go: the instructions for the AI,
// the fixed list of flags, and the criteria in the order they are graded, each with a
// weight, what strong, acceptable and weak answers look like, and the questions it reads.
// The page remounts this after a save (keyed on the saved draft), so a new criterion
// comes back with its key fixed. Publishing works on the saved draft only.

type FlagRow = { id: number; key: string; label: string; saved: boolean };

type CriterionRow = {
  id: number;
  criterionId: string | null;
  key: string;
  name: string;
  weight: string;
  guidanceStrong: string;
  guidanceAcceptable: string;
  guidanceWeak: string;
  questionIds: string[];
  meaningChanged: boolean;
};

let nextRowId = 1;
const rowId = () => nextRowId++;

const iconButton = "size-11 sm:size-8";

function toPayload(instructions: string, flags: FlagRow[], criteria: CriterionRow[]): Omit<SaveRubricDraftActionInput, "roleId" | "rubricVersionId"> {
  return {
    instructions,
    allowedFlags: flags.map((flag) => ({ key: flag.key.trim() || null, label: flag.label })),
    criteria: criteria.map((row) => ({
      criterionId: row.criterionId,
      key: row.criterionId ? null : row.key.trim() || null,
      name: row.name,
      weight: row.weight.trim() === "" ? Number.NaN : Number(row.weight),
      guidanceStrong: row.guidanceStrong,
      guidanceAcceptable: row.guidanceAcceptable,
      guidanceWeak: row.guidanceWeak,
      questionIds: row.questionIds,
      meaningChanged: row.meaningChanged,
    })),
  };
}

export function RubricEditor({
  roleId,
  roleName,
  draft,
  published,
  questions,
  problems,
  mode,
  submittedCount,
  cap,
  justSaved,
  onSaved,
}: {
  roleId: string;
  roleName: string;
  draft: RubricVersionView;
  published: RubricVersionView | null;
  questions: RubricQuestionOption[];
  problems: RubricProblem[];
  mode: ScoringMode;
  submittedCount: number;
  cap: number;
  // A save went through; the notice survives the remount that follows it.
  justSaved: boolean;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [initial] = useState(() => ({
    instructions: draft.instructions,
    flags: draft.allowedFlags.map((flag): FlagRow => ({ id: rowId(), key: flag.key, label: flag.label, saved: true })),
    criteria: draft.criteria.map(
      (criterion): CriterionRow => ({
        id: rowId(),
        criterionId: criterion.criterionId,
        key: criterion.key,
        name: criterion.name,
        weight: String(criterion.weight),
        guidanceStrong: criterion.guidanceStrong,
        guidanceAcceptable: criterion.guidanceAcceptable,
        guidanceWeak: criterion.guidanceWeak,
        questionIds: criterion.questionIds,
        meaningChanged: criterion.meaningChanged,
      }),
    ),
  }));
  const [instructions, setInstructions] = useState(initial.instructions);
  const [flags, setFlags] = useState(initial.flags);
  const [criteria, setCriteria] = useState(initial.criteria);
  const [savedBaseline, setSavedBaseline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const baseline = useMemo(() => JSON.stringify(toPayload(initial.instructions, initial.flags, initial.criteria)), [initial]);
  const current = JSON.stringify(toPayload(instructions, flags, criteria));
  const dirty = current !== (savedBaseline ?? baseline);

  const questionById = useMemo(() => new Map(questions.map((question) => [question.questionId, question])), [questions]);
  const inPublished = useMemo(() => new Set(published?.criteria.map((criterion) => criterion.criterionId) ?? []), [published]);
  const totalWeight = criteria.reduce((sum, row) => sum + (Number(row.weight) > 0 ? Number(row.weight) : 0), 0);

  function updateCriterion(id: number, patch: Partial<CriterionRow>) {
    setCriteria((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function moveCriterion(index: number, direction: -1 | 1) {
    setCriteria((rows) => {
      const target = index + direction;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function save() {
    setError(null);
    const sent = current;
    startTransition(async () => {
      const result = await saveRubricDraftAction({ roleId, rubricVersionId: draft.id, ...toPayload(instructions, flags, criteria) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSavedBaseline(sent);
      onSaved();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft version {draft.version}</CardTitle>
        <CardDescription>
          Nothing here is live. Publishing locks this draft as version {draft.version}
          {published ? ` and retires version ${published.version}` : ""}; scores already made keep their version.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <Field
          label="Instructions for the AI"
          htmlFor="rubric-instructions"
          hint="Plain words about the job and what to reward. The scorer adds its own fairness rules: it ignores spelling, grammar, length and language, and never considers protected traits or criminal history."
        >
          <Textarea id="rubric-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} className="min-h-28" />
        </Field>

        <section className="grid gap-3">
          <div>
            <h3 className="text-sm font-medium">Flags</h3>
            <p className="text-xs text-muted-foreground">A short, fixed list of job-related red flags. The AI may raise only these, and only when one clearly applies.</p>
          </div>
          {flags.length > 0 ? (
            <ul className="grid gap-2">
              {flags.map((flag) => (
                <li key={flag.id} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-center">
                  <Input
                    aria-label="Flag label"
                    value={flag.label}
                    onChange={(e) => setFlags((rows) => rows.map((row) => (row.id === flag.id ? { ...row, label: e.target.value } : row)))}
                    placeholder="Describes missing work without telling anyone"
                    maxLength={200}
                    className="h-11 sm:h-9"
                  />
                  {flag.saved ? (
                    <span className="font-mono text-xs text-muted-foreground" title="A saved flag keeps its key">
                      {flag.key}
                    </span>
                  ) : (
                    <Input
                      aria-label="Flag key"
                      value={flag.key}
                      onChange={(e) => setFlags((rows) => rows.map((row) => (row.id === flag.id ? { ...row, key: e.target.value } : row)))}
                      placeholder={slugKey(flag.label) || "key_in_lowercase"}
                      maxLength={64}
                      className="h-11 font-mono sm:h-9"
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={iconButton}
                    aria-label={`Remove flag ${flag.label || flag.key}`}
                    onClick={() => setFlags((rows) => rows.filter((row) => row.id !== flag.id))}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No flags. The AI raises none.</p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 sm:h-8"
              onClick={() => setFlags((rows) => [...rows, { id: rowId(), key: "", label: "", saved: false }])}
            >
              <Plus /> Add flag
            </Button>
          </div>
        </section>

        <section className="grid gap-3">
          <div>
            <h3 className="text-sm font-medium">Criteria</h3>
            <p className="text-xs text-muted-foreground">
              The AI grades each one from 1 to 5 using only the answers it reads. The app turns the grades and weights into the 1 to 100 score.
            </p>
          </div>
          {criteria.map((row, index) => (
            <CriterionEditor
              key={row.id}
              row={row}
              index={index}
              count={criteria.length}
              share={weightShare(Number(row.weight), totalWeight)}
              questions={questions}
              questionById={questionById}
              canChangeMeaning={row.criterionId !== null && inPublished.has(row.criterionId)}
              publishedVersion={published?.version ?? null}
              onChange={(patch) => updateCriterion(row.id, patch)}
              onMove={(direction) => moveCriterion(index, direction)}
              onRemove={() => setCriteria((rows) => rows.filter((other) => other.id !== row.id))}
            />
          ))}
          {criteria.length === 0 ? <p className="text-sm text-muted-foreground">No criteria yet. Add one for each behavior the questions show.</p> : null}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 sm:h-8"
              onClick={() =>
                setCriteria((rows) => [
                  ...rows,
                  {
                    id: rowId(),
                    criterionId: null,
                    key: "",
                    name: "",
                    weight: "10",
                    guidanceStrong: "",
                    guidanceAcceptable: "",
                    guidanceWeak: "",
                    questionIds: [],
                    meaningChanged: false,
                  },
                ])
              }
            >
              <Plus /> Add criterion
            </Button>
          </div>
        </section>

        {problems.length > 0 && !dirty ? (
          <Notice tone="warning">
            <span className="block font-medium">Before this can be published:</span>
            {problems.map((problem, index) => (
              <span key={index} className="block">
                {problem.message}
              </span>
            ))}
          </Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {justSaved && !dirty && !error ? <Notice>Saved.</Notice> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={save} disabled={pending || !dirty} className="h-11 sm:h-9">
            {pending ? "Saving..." : "Save draft"}
          </Button>
          <Button type="button" variant="outline" onClick={() => setPublishOpen(true)} disabled={pending || dirty} className="h-11 sm:h-9">
            Publish version {draft.version}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 text-destructive hover:text-destructive sm:h-9"
            onClick={() => setDiscardOpen(true)}
            disabled={pending}
          >
            Discard draft
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes. Save before publishing or trying them.</span> : null}
        </div>
      </CardContent>

      <PublishRubricDialog
        open={publishOpen}
        onOpenChange={(open) => {
          setPublishOpen(open);
          if (!open) router.refresh();
        }}
        roleId={roleId}
        roleName={roleName}
        draft={{ id: draft.id, version: draft.version }}
        publishedVersion={published?.version ?? null}
        criteriaCount={draft.criteria.length}
        problems={problems}
        mode={mode}
        submittedCount={submittedCount}
        cap={cap}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(open) => {
          setDiscardOpen(open);
          if (!open) router.refresh();
        }}
        title="Discard this draft?"
        description={`Draft version ${draft.version} and its unpublished changes are thrown away. ${published ? `Version ${published.version} stays published and untouched.` : ""}`}
        confirmLabel="Discard draft"
        destructive
        onConfirm={async () => {
          const result = await discardRubricDraftAction({ roleId, rubricVersionId: draft.id });
          return result.ok ? undefined : result.message;
        }}
      />
    </Card>
  );
}

function CriterionEditor({
  row,
  index,
  count,
  share,
  questions,
  questionById,
  canChangeMeaning,
  publishedVersion,
  onChange,
  onMove,
  onRemove,
}: {
  row: CriterionRow;
  index: number;
  count: number;
  share: number | null;
  questions: RubricQuestionOption[];
  questionById: Map<string, RubricQuestionOption>;
  canChangeMeaning: boolean;
  publishedVersion: number | null;
  onChange: (patch: Partial<CriterionRow>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = `criterion-${row.id}`;
  const label = row.name.trim() || `criterion ${index + 1}`;
  const available = questions.filter((question) => !row.questionIds.includes(question.questionId));
  return (
    <fieldset className="grid gap-3 rounded-md border p-3" aria-label={`Criterion ${index + 1}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {index + 1}. {row.name.trim() || "New criterion"}{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">{row.criterionId ? row.key : row.key.trim() || slugKey(row.name) || ""}</span>
        </p>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="icon-sm" className={iconButton} aria-label={`Move ${label} up`} onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className={iconButton} aria-label={`Move ${label} down`} onClick={() => onMove(1)} disabled={index === count - 1}>
            <ArrowDown />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className={iconButton} aria-label={`Remove ${label}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} value={row.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={120} className="h-11 sm:h-9" />
        </Field>
        <Field label="Weight" htmlFor={`${id}-weight`} hint={share !== null ? `${share}% of the score` : "Above 0"}>
          <Input
            id={`${id}-weight`}
            type="number"
            inputMode="decimal"
            min={0.01}
            max={999.99}
            step={0.01}
            value={row.weight}
            onChange={(e) => onChange({ weight: e.target.value })}
            className="h-11 sm:h-9"
          />
        </Field>
      </div>
      {!row.criterionId ? (
        <Field label="Key" htmlFor={`${id}-key`} hint="How reports name this criterion. Set when you save it; it never changes after.">
          <Input
            id={`${id}-key`}
            value={row.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder={slugKey(row.name) || "key_in_lowercase"}
            maxLength={64}
            className="h-11 font-mono sm:h-9"
          />
        </Field>
      ) : null}

      <Field label="Strong answer (5)" htmlFor={`${id}-strong`}>
        <Textarea id={`${id}-strong`} value={row.guidanceStrong} onChange={(e) => onChange({ guidanceStrong: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Acceptable answer (3)" htmlFor={`${id}-acceptable`}>
        <Textarea id={`${id}-acceptable`} value={row.guidanceAcceptable} onChange={(e) => onChange({ guidanceAcceptable: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Weak answer (1)" htmlFor={`${id}-weak`}>
        <Textarea id={`${id}-weak`} value={row.guidanceWeak} onChange={(e) => onChange({ guidanceWeak: e.target.value })} maxLength={2000} />
      </Field>

      <div className="grid gap-2">
        <p className="text-sm font-medium">Questions it reads</p>
        {row.questionIds.length > 0 ? (
          <ul className="grid gap-1">
            {row.questionIds.map((questionId) => {
              const question = questionById.get(questionId);
              return (
                <li key={questionId} className="flex items-start justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                  <span className="min-w-0 py-1">
                    <span className="font-mono text-xs text-muted-foreground">{question?.key ?? "not a question of this role"}</span>{" "}
                    {question?.prompt}
                    {question?.aiNeverSend ? (
                      <Badge variant="outline" className="ml-1 border-amber-400 text-amber-800 dark:text-amber-200">
                        Never sent to AI
                      </Badge>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={iconButton}
                    aria-label={`Stop reading ${question?.key ?? "this question"}`}
                    onClick={() => onChange({ questionIds: row.questionIds.filter((other) => other !== questionId) })}
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet. Pick at least one.</p>
        )}
        {available.length > 0 ? (
          <NativeSelect
            aria-label={`Add a question for ${label}`}
            value=""
            onChange={(e) => {
              if (e.target.value) onChange({ questionIds: [...row.questionIds, e.target.value] });
            }}
            className="h-11 sm:h-9"
          >
            <option value="">Add a question...</option>
            {available.map((question) => (
              <option key={question.questionId} value={question.questionId} disabled={question.aiNeverSend}>
                {question.key}: {question.prompt.length > 70 ? `${question.prompt.slice(0, 70)}...` : question.prompt}
                {question.aiNeverSend ? " (never sent to AI)" : question.onLiveForm ? "" : " (not on the live form)"}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>

      {canChangeMeaning ? (
        <CheckboxField
          label={`Asks for something different from version ${publishedVersion}`}
          hint="Tick when the guidance changes what a good answer is. Reports stop pooling this criterion's grades across the change."
          checked={row.meaningChanged}
          onChange={(e) => onChange({ meaningChanged: e.target.checked })}
        />
      ) : null}
    </fieldset>
  );
}
