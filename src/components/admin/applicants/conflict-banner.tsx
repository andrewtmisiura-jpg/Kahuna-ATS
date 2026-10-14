"use client";

import { Button } from "@/components/ui/button";
import { resolveContactConflict } from "@/server/actions/admin/applications";
import type { ProfileConflict } from "@/server/services/applications/queries";
import { ActionNotice } from "./fields";
import { formatDateTime, formatMobile } from "./format";
import { useAdminAction } from "./use-admin-action";

// A landing attempt whose mobile and email pointed at different people
// (DATA_MODEL.md, landing_conflict): two buttons resolve it.

export function ConflictBanner({ conflicts, personId, canAct }: { conflicts: ProfileConflict[]; personId: string; canAct: boolean }) {
  const { run, pending, failure } = useAdminAction();
  if (conflicts.length === 0) return null;
  return (
    <div className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">Contact conflict</p>
      {conflicts.map((c) => (
        <div key={c.id} className="grid gap-2">
          <p>
            On {formatDateTime(c.createdAt)} someone typed {c.typedName || "a name"} with {formatMobile(c.typedMobile) || "no mobile"} and {c.typedEmail ?? "no email"}, which do not
            match what is on file together. No application was created for them.
          </p>
          {canAct ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => resolveContactConflict({ conflictId: c.id, personId, resolution: "update_email" }))}>
                Update email on file
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => resolveContactConflict({ conflictId: c.id, personId, resolution: "mark_shared" }))}>
                Mark phone as shared
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <ActionNotice failure={failure} />
    </div>
  );
}
