"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reopenApplication } from "@/server/actions/admin/applications";
import type { StageOption } from "@/server/services/applications/queries";
import { ActionNotice, Field, NativeSelect, OccurredAtField, Textarea } from "./fields";
import { useAdminAction } from "./use-admin-action";

// Reopen a closed application into a stage (any stage before Hired).

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; eventSeq: number; stageId: string };
  stages: StageOption[];
};

export function ReopenDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open ? <ReopenForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function ReopenForm({ onOpenChange, application, stages }: Props) {
  const choices = stages.filter((s) => s.milestone !== "hired");
  const [stageId, setStageId] = useState(choices.some((s) => s.id === application.stageId) ? application.stageId : (choices[0]?.id ?? ""));
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | undefined>(undefined);
  const { run, pending, failure } = useAdminAction();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () => reopenApplication({ applicationId: application.id, expectedSeq: application.eventSeq, toStageId: stageId, note: note || null, occurredAt }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Reopen</DialogTitle>
        <DialogDescription>The application goes back to a stage; the closed reason stays in the history.</DialogDescription>
      </DialogHeader>
      <Field label="Stage">
        <NativeSelect value={stageId} onChange={(e) => setStageId(e.target.value)}>
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <OccurredAtField value={occurredAt} onChange={setOccurredAt} />
      <Field label="Note (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !stageId}>
          {pending ? "Reopening" : "Reopen"}
        </Button>
      </DialogFooter>
    </form>
  );
}
