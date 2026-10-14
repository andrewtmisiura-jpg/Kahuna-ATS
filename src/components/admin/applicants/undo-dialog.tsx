"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { undoApplicationChange } from "@/server/actions/admin/applications";
import type { UndoPreview } from "@/server/services/applications/corrections";
import { ActionNotice } from "./fields";
import { formatDateTime } from "./format";
import { useAdminAction } from "./use-admin-action";

// "Undo last change": a confirmation that names the change and what undoing it
// does, then voids it through the transition function. The change stays in the
// stage history, marked voided.

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; eventSeq: number };
  undo: UndoPreview;
};

export function UndoDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open ? <UndoBody {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function UndoBody({ onOpenChange, application, undo }: Props) {
  const { run, pending, failure } = useAdminAction();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Undo last change?</DialogTitle>
        <DialogDescription>Use this when the last change was a mistake.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 text-sm">
        <div className="rounded-md border p-3">
          <p className="font-medium">{undo.summary}</p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(undo.occurredAt)}
            {undo.actorName ? `, by ${undo.actorName}` : ""}
          </p>
        </div>
        <ul className="list-disc pl-5">
          {undo.effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
      </div>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() =>
            run(
              () => undoApplicationChange({ applicationId: application.id, expectedSeq: application.eventSeq, eventId: undo.eventId }),
              () => onOpenChange(false),
            )
          }
        >
          {pending ? "Undoing" : "Undo this change"}
        </Button>
      </DialogFooter>
    </>
  );
}
