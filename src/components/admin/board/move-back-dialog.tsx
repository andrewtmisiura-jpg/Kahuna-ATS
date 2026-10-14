"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Moving a card to an earlier stage is allowed, but it is asked first so a slip
// of the mouse does not rewrite someone's progress. Leaving Hired undoes the hire.

type Props = {
  open: boolean;
  name: string;
  stageName: string;
  fromHired: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function MoveBackDialog({ open, name, stageName, fromHired, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move back?</DialogTitle>
          <DialogDescription>
            Move {name} back to {stageName}? The move is recorded in the stage history with your name, like any other.
          </DialogDescription>
        </DialogHeader>
        {fromHired ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            This undoes the hire. The hire record is kept and marked as entered in error.
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Move back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
