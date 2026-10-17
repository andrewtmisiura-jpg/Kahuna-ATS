"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ScoringMode } from "@/db/schema";
import { publishRubricAction } from "@/server/actions/admin/rubrics";
import type { RubricProblem } from "@/server/services/scoring/rubrics";
import { Field, Notice, Textarea } from "../fields";
import { plural } from "./format";

// Publishing needs a written reason, never a passing Try it run, and says what it does:
// a locked version, the previous one retired, and a re-score when scoring is on.
export function PublishRubricDialog({
  open,
  onOpenChange,
  roleId,
  roleName,
  draft,
  publishedVersion,
  criteriaCount,
  problems,
  mode,
  submittedCount,
  cap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleId: string;
  roleName: string;
  draft: { id: string; version: number };
  publishedVersion: number | null;
  criteriaCount: number;
  problems: RubricProblem[];
  mode: ScoringMode;
  submittedCount: number;
  cap: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        {open ? (
          <PublishForm
            roleId={roleId}
            roleName={roleName}
            draft={draft}
            publishedVersion={publishedVersion}
            criteriaCount={criteriaCount}
            problems={problems}
            mode={mode}
            submittedCount={submittedCount}
            cap={cap}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({
  roleId,
  roleName,
  draft,
  publishedVersion,
  criteriaCount,
  problems,
  mode,
  submittedCount,
  cap,
  onClose,
}: {
  roleId: string;
  roleName: string;
  draft: { id: string; version: number };
  publishedVersion: number | null;
  criteriaCount: number;
  problems: RubricProblem[];
  mode: ScoringMode;
  submittedCount: number;
  cap: number;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await publishRubricAction({ roleId, rubricVersionId: draft.id, changeReason: reason });
      if (!result.ok) setError(result.message);
      else onClose();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Publish version {draft.version}</DialogTitle>
        <DialogDescription>This makes the draft the rubric {roleName} applications are scored with.</DialogDescription>
      </DialogHeader>

      <Notice>
        <span className="block">
          Version {draft.version} is locked the moment it is published: {plural(criteriaCount, "criterion", "criteria")}, their weights and guidance.
        </span>
        <span className="mt-1 block">
          {publishedVersion !== null
            ? `Version ${publishedVersion} is retired. Scores already made keep the version they came from.`
            : "This role has no published version yet, so nothing is retired."}
        </span>
        <span className="mt-1 block">
          {mode === "off"
            ? "Scoring is off for this role, so nothing is scored until you turn it on."
            : `Scoring is ${mode}: within about five minutes every submitted application (${submittedCount}) is queued for a new score, up to the daily limit of ${cap}.`}
        </span>
        <span className="mt-1 block">No Try it run is needed to publish. The reason below is kept with the version.</span>
      </Notice>

      {problems.length > 0 ? (
        <Notice tone="warning">
          <span className="block font-medium">Fix these before publishing:</span>
          {problems.map((problem, index) => (
            <span key={index} className="block">
              {problem.message}
            </span>
          ))}
        </Notice>
      ) : null}

      <Field label="Why is the rubric changing?" htmlFor="rubric-change-reason" hint="Required. A short, job-related reason, kept with the version for the record.">
        <Textarea id="rubric-change-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus required />
      </Field>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending} className="h-11 sm:h-9">
          Cancel
        </Button>
        <Button type="submit" disabled={pending || problems.length > 0 || !reason.trim()} className="h-11 sm:h-9">
          {pending ? "Publishing..." : `Publish version ${draft.version}`}
        </Button>
      </DialogFooter>
    </form>
  );
}
