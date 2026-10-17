"use client";

import { ActionNotice } from "@/components/admin/applicants/fields";
import { useAdminAction } from "@/components/admin/applicants/use-admin-action";
import { Button } from "@/components/ui/button";
import { confirmMatchAction, dismissSuggestionAction, unmatchAttendeeAction } from "@/server/actions/admin/attendees";
import { TAP } from "./format";

// The staff buttons in the profile's attendance panel. Viewers never get them; the
// actions check the role again.

export function UnmatchButton({ attendeeId, nameAsWritten }: { attendeeId: string; nameAsWritten: string }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <span className="grid gap-1">
      <span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={TAP}
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Is "${nameAsWritten}" someone else? This unmatches them from this application.`)) {
              run(() => unmatchAttendeeAction({ attendeeId }));
            }
          }}
        >
          Not this person? Unmatch
        </Button>
      </span>
      <ActionNotice failure={failure} />
    </span>
  );
}

export function SuggestionButtons({ attendeeId, applicationId }: { attendeeId: string; applicationId: string }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <span className="grid gap-1">
      <span className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className={TAP} disabled={pending} onClick={() => run(() => confirmMatchAction({ attendeeId, applicationId }))}>
          It&apos;s them
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={TAP}
          disabled={pending}
          onClick={() => run(() => dismissSuggestionAction({ attendeeId, applicationId }))}
        >
          Not them
        </Button>
      </span>
      <ActionNotice failure={failure} />
    </span>
  );
}
