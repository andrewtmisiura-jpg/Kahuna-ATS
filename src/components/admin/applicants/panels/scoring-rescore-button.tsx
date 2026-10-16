"use client";

import { Button } from "@/components/ui/button";
import { rescoreApplicationAction } from "@/server/actions/admin/scoring";
import { ActionNotice } from "../fields";
import { useAdminAction } from "../use-admin-action";

// Admin only: queues a fresh score against the published rubric version. The next cron
// pass runs it, within five minutes; the page then shows the new score as current.
export function RescoreButton({ applicationId, queued }: { applicationId: string; queued: boolean }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <div className="mt-3 grid justify-items-start gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-8"
        disabled={queued || pending}
        onClick={() => run(() => rescoreApplicationAction({ applicationId }))}
      >
        {queued ? "Re-score queued" : "Re-score"}
      </Button>
      <ActionNotice failure={failure} />
    </div>
  );
}
