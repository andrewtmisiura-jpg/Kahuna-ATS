"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addTestCaseAction, updateTestCaseAction } from "@/server/actions/admin/rubrics";
import type { TestCaseVariant, TestCaseView } from "@/server/services/scoring/test-cases";
import { Field, NativeSelect, Notice, Textarea } from "../fields";
import { groupLabel, VARIANT_LABELS, VARIANTS } from "./format";

// Add or edit one sample: its group, which way it is written and an answer to each
// question the rubric reads. Answers to questions the rubric no longer reads are kept.

export type TestCaseDialogMode = { kind: "add" } | { kind: "edit"; testCase: TestCaseView };

export function TestCaseDialog({
  open,
  onOpenChange,
  roleId,
  rubricId,
  mode,
  questions,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleId: string;
  rubricId: string;
  mode: TestCaseDialogMode | null;
  questions: { key: string; prompt: string }[];
  groups: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        {open && mode ? (
          <TestCaseForm
            key={mode.kind === "edit" ? mode.testCase.id : "add"}
            roleId={roleId}
            rubricId={rubricId}
            mode={mode}
            questions={questions}
            groups={groups}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TestCaseForm({
  roleId,
  rubricId,
  mode,
  questions,
  groups,
  onClose,
}: {
  roleId: string;
  rubricId: string;
  mode: TestCaseDialogMode;
  questions: { key: string; prompt: string }[];
  groups: string[];
  onClose: () => void;
}) {
  const existing = mode.kind === "edit" ? mode.testCase : null;
  const [group, setGroup] = useState(existing ? groupLabel(existing.groupKey) : "");
  const [variant, setVariant] = useState<TestCaseVariant>(existing?.variant ?? "standard");
  const [answers, setAnswers] = useState<Record<string, string>>(existing?.answers ?? {});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = existing
        ? await updateTestCaseAction({ roleId, testCaseId: existing.id, groupKey: group, variant, answers })
        : await addTestCaseAction({ roleId, rubricId, groupKey: group, variant, answers });
      if (!result.ok) setError(result.message);
      else onClose();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{existing ? "Edit sample" : "Add a sample"}</DialogTitle>
        <DialogDescription>
          Made-up answers with no names or numbers. Samples in one group say the same thing in different ways, so their scores should land close.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Group" htmlFor={`${ids}-group`} hint="For example Solid answers or Red flag answers.">
          <Input id={`${ids}-group`} value={group} onChange={(e) => setGroup(e.target.value)} list={`${ids}-groups`} maxLength={60} className="h-11 sm:h-9" required />
          <datalist id={`${ids}-groups`}>
            {groups.map((key) => (
              <option key={key} value={groupLabel(key)} />
            ))}
          </datalist>
        </Field>
        <Field label="Written" htmlFor={`${ids}-variant`}>
          <NativeSelect id={`${ids}-variant`} value={variant} onChange={(e) => setVariant(e.target.value as TestCaseVariant)} className="h-11 sm:h-9">
            {VARIANTS.map((value) => (
              <option key={value} value={value}>
                {VARIANT_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      {questions.length > 0 ? (
        questions.map((question) => (
          <Field key={question.key} label={question.key} htmlFor={`${ids}-${question.key}`} hint={question.prompt}>
            <Textarea
              id={`${ids}-${question.key}`}
              value={answers[question.key] ?? ""}
              onChange={(e) => setAnswers((current) => ({ ...current, [question.key]: e.target.value }))}
              maxLength={4000}
            />
          </Field>
        ))
      ) : (
        <Notice tone="warning">The rubric reads no questions yet. Add criteria with their questions first.</Notice>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending} className="h-11 sm:h-9">
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !group.trim()} className="h-11 sm:h-9">
          {pending ? "Saving..." : existing ? "Save sample" : "Add sample"}
        </Button>
      </DialogFooter>
    </form>
  );
}
