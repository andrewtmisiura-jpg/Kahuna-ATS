"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { publishFormAction } from "@/server/actions/admin/questions";
import type { FormSnapshot } from "@/server/services/forms/editor";
import type { DraftProblem } from "@/server/services/forms/publish";
import { ErrorText, Field, Notice, Textarea, Warning } from "./fields";

// Publishing needs a written reason and explains what it does: a locked version,
// new applications on it, applications already started untouched.

export function PublishDialog({
  open,
  onOpenChange,
  roleId,
  draft,
  published,
  problems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleId: string;
  draft: FormSnapshot;
  published: FormSnapshot | null;
  problems: DraftProblem[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open ? <PublishForm roleId={roleId} draft={draft} published={published} problems={problems} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({
  roleId,
  draft,
  published,
  problems,
  onClose,
}: {
  roleId: string;
  draft: FormSnapshot;
  published: FormSnapshot | null;
  problems: DraftProblem[];
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const newVersions = draft.items.filter((item) => !item.publishedAt).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await publishFormAction({ roleId, formVersionId: draft.id, changeReason: reason });
      if (!result.ok) setError(result.message);
      else onClose();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Publish version {draft.version}</DialogTitle>
        <DialogDescription>This makes the draft the live form for new applications.</DialogDescription>
      </DialogHeader>

      <Notice>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            Version {draft.version} is locked the moment it is published: {draft.items.length} question{draft.items.length === 1 ? "" : "s"} in{" "}
            {draft.sections.length} section{draft.sections.length === 1 ? "" : "s"}
            {newVersions > 0 ? `, including ${newVersions} new or reworded wording${newVersions === 1 ? "" : "s"}` : ""}.
          </li>
          {published ? (
            <li>
              Version {published.version} is retired. The {published.applicationCount} application{published.applicationCount === 1 ? "" : "s"} started on
              it keep it to the end; nobody is asked to answer again.
            </li>
          ) : (
            <li>This role has no published form yet, so applications can start only after this publish.</li>
          )}
          <li>Everyone who starts after this sees version {draft.version}. Reports show which version each applicant answered.</li>
        </ul>
      </Notice>

      {problems.length > 0 ? (
        <Warning>
          <p className="font-medium">Fix these before publishing:</p>
          <ul className="list-disc pl-4">
            {problems.map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
        </Warning>
      ) : null}

      <Field label="Why is the form changing?" htmlFor="change-reason" hint="Required. A short, job-related reason, kept with the version for the record.">
        <Textarea id="change-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus required />
      </Field>

      <ErrorText>{error}</ErrorText>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || problems.length > 0 || !reason.trim()}>
          {pending ? "Publishing..." : `Publish version ${draft.version}`}
        </Button>
      </DialogFooter>
    </form>
  );
}
