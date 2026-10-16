"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rescoreRoleAction } from "@/server/actions/admin/scoring";
import { Notice } from "../fields";
import { plural } from "./format";

// "Re-score all submitted applications for this role": one job per application against the
// published version, which the cron works through under the daily limit. The confirmation
// says how many and how long the limit makes it take.
export function RescoreAllButton({
  roleId,
  roleName,
  version,
  submittedCount,
  cap,
  usedToday,
}: {
  roleId: string;
  roleName: string;
  version: number;
  submittedCount: number;
  cap: number;
  usedToday: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const leftToday = Math.max(cap - usedToday, 0);
  const days = submittedCount <= leftToday ? 1 : 1 + Math.ceil((submittedCount - leftToday) / cap);

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await rescoreRoleAction({ roleId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setQueued(result.data.queued);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="grid justify-items-start gap-2">
      <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(true)} disabled={submittedCount === 0}>
        Re-score all submitted applications for this role
      </Button>
      {queued !== null ? (
        <Notice>
          {queued === 0 ? "Nothing new to queue: every application already has a score on its way." : `${plural(queued, "score")} queued. They arrive over the next passes.`}
        </Notice>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-score all submitted applications for this role?</DialogTitle>
            <DialogDescription>
              {roleName}: {plural(submittedCount, "submitted application")}, each scored again against rubric version {version}.
            </DialogDescription>
          </DialogHeader>
          <Notice>
            <span className="block">
              Scores run a few at a time every five minutes, up to the daily limit of {cap} across all roles ({usedToday} used today).
              {days > 1 ? ` At this limit the last ones arrive in about ${plural(days, "day")}.` : " They should all arrive today."}
            </span>
            <span className="mt-1 block">
              Each new score replaces the current one when it lands. Applications already waiting for a score are skipped. Nothing moves, closes or
              messages anyone.
            </span>
          </Notice>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={confirm} disabled={pending}>
              {pending ? "Queueing..." : `Re-score ${plural(submittedCount, "application")}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
