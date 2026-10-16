"use client";

import { useState } from "react";
import { setApplicationArrival } from "@/server/actions/admin/applications";
import { ActionNotice, NativeSelect } from "./fields";
import { ARRIVAL_OPTIONS, arrivalLabel, type ArrivalValue } from "./format";
import { useAdminAction } from "./use-admin-action";

// Whether the person showed up on time to the group interview. Hiring Managers
// and Admins set it on the profile or, right after a session, on the session
// page; Viewers see the value only. Each change is audited by the service. The
// pick shows at once; a failed save shows the stored value again. Parents key it
// by the stored value so a refresh resets it.
export function ArrivalSelect({
  applicationId,
  value,
  canAct,
  label = "Group interview arrival",
  className,
}: {
  applicationId: string;
  value: ArrivalValue | null;
  canAct: boolean;
  label?: string;
  className?: string;
}) {
  const { run, pending, failure } = useAdminAction();
  const [picked, setPicked] = useState<ArrivalValue | null>(value);
  if (!canAct) return <span>{arrivalLabel(value)}</span>;
  const shown = failure ? value : picked;
  return (
    <span className="grid gap-1">
      <NativeSelect
        aria-label={label}
        className={className ?? "h-8 w-auto"}
        value={shown ?? ""}
        disabled={pending}
        onChange={(e) => {
          const next = (e.target.value || null) as ArrivalValue | null;
          setPicked(next);
          run(() => setApplicationArrival({ applicationId, arrival: next }));
        }}
      >
        {ARRIVAL_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value="">Not recorded</option>
      </NativeSelect>
      <ActionNotice failure={failure} />
    </span>
  );
}
