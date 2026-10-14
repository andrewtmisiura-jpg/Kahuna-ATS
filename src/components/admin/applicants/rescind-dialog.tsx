"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rescindApplicationHire } from "@/server/actions/admin/applications";
import type { ProfileCheck, StageOption } from "@/server/services/applications/queries";
import { OpenCheckWarning, OutcomeReasonFields, useCloseChoice, type ClosePicklists } from "./close-dialog";
import { ActionNotice, Field, NativeSelect, OccurredAtField, Textarea } from "./fields";
import { useAdminAction } from "./use-admin-action";

// "Rescind hire" (DATA_MODEL.md, hire_rescinded): for a hire that really fell
// through. The hire record is kept and marked rescinded; the application is either
// closed with an outcome and reason, or put back in a stage the user picks (by
// default the stage they were in before Hired). A mistaken move to Hired is
// undone with "Undo last change" instead.

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; eventSeq: number };
  stages: StageOption[];
  picklists: ClosePicklists;
  checks: ProfileCheck[];
  defaultStageId: string | null;
};

export function RescindDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <RescindForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function RescindForm({ onOpenChange, application, stages, picklists, checks, defaultStageId }: Props) {
  const modeName = useId();
  const [mode, setMode] = useState<"closed" | "open">("closed");
  const choice = useCloseChoice(picklists, checks, "withdrew");
  const stageChoices = stages.filter((s) => s.milestone !== "hired");
  const [stageId, setStageId] = useState(
    defaultStageId && stageChoices.some((s) => s.id === defaultStageId) ? defaultStageId : (stageChoices.at(-1)?.id ?? ""),
  );
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | undefined>(undefined);
  const { run, pending, failure } = useAdminAction();

  const noteRequired = mode === "open" || Boolean(choice.reason?.requiresNote);
  const ready = mode === "open" ? Boolean(stageId) && note.trim() !== "" : choice.ready && (!noteRequired || note.trim() !== "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () =>
        rescindApplicationHire({
          applicationId: application.id,
          expectedSeq: application.eventSeq,
          occurredAt,
          note: note || null,
          to:
            mode === "open"
              ? { status: "open", toStageId: stageId }
              : { status: "closed", outcome: choice.outcome, reasonOptionId: choice.reasonId, fcra: choice.fcra },
        }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rescind hire</DialogTitle>
        <DialogDescription>
          For a hire that fell through, like someone who backed out before starting. The hire record is kept and marked rescinded. If moving them to
          Hired was a mistake, use Undo last change instead.
        </DialogDescription>
      </DialogHeader>

      <Field label="What happens to the application?" group>
        <div className="grid gap-2">
          {(
            [
              { value: "closed", label: "Close it", hint: "Pick the outcome and the reason." },
              { value: "open", label: "Put it back in a stage", hint: "They are still in the running." },
            ] as const
          ).map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input type="radio" name={modeName} className="mt-1" checked={mode === o.value} onChange={() => setMode(o.value)} />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {mode === "closed" ? (
        <>
          <OpenCheckWarning choice={choice} />
          <OutcomeReasonFields choice={choice} />
        </>
      ) : (
        <Field label="Back to stage" hint="Starts on the stage they were in before Hired.">
          <NativeSelect value={stageId} onChange={(e) => setStageId(e.target.value)} required>
            {stageChoices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      <OccurredAtField value={occurredAt} onChange={setOccurredAt} />

      <Field label={mode === "open" ? "Why is the hire rescinded? (required)" : noteRequired ? "Note (required for this reason)" : "Note (optional)"}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={noteRequired} />
      </Field>

      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending || !ready}>
          {pending ? "Rescinding" : "Rescind hire"}
        </Button>
      </DialogFooter>
    </form>
  );
}
