"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveBackgroundCheck } from "@/server/actions/admin/applications";
import type { UserRole } from "@/server/auth/roles";
import type { ProfileCheck } from "@/server/services/applications/queries";
import { addWeekdays } from "@/server/services/time";
import { ActionNotice, Field, NativeSelect, Textarea } from "./fields";
import { CHECK_STATUS_LABELS, CHECK_TYPE_LABELS, formatCalendarDate } from "./format";
import { Empty, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// The background check panel: status and dates only, never report contents.
// The pre-adverse notice date is write-once except for Admins.

export function CheckPanel({ checks, role }: { checks: ProfileCheck[]; role: UserRole }) {
  if (role === "viewer") return null;
  return (
    <Section title="Background check">
      {checks.length === 0 ? <Empty>No check yet. Moving to the check stage creates one, after a conditional offer.</Empty> : null}
      <div className="grid gap-5">
        {checks.map((check) => (
          <CheckForm key={check.id} check={check} role={role} />
        ))}
      </div>
    </Section>
  );
}

function CheckForm({ check, role }: { check: ProfileCheck; role: UserRole }) {
  const [status, setStatus] = useState(check.status);
  const [vendor, setVendor] = useState(check.vendor ?? "");
  const [vendorReference, setVendorReference] = useState(check.vendorReference ?? "");
  const [requestedOn, setRequestedOn] = useState(check.requestedOn ?? "");
  const [completedOn, setCompletedOn] = useState(check.completedOn ?? "");
  const [preAdverseNoticeOn, setPreAdverseNoticeOn] = useState(check.preAdverseNoticeOn ?? "");
  const [finalAdverseOn, setFinalAdverseOn] = useState(check.finalAdverseOn ?? "");
  const [note, setNote] = useState(check.note ?? "");
  const { run, pending, failure } = useAdminAction();
  const preAdverseLocked = Boolean(check.preAdverseNoticeOn) && role !== "admin";
  const earliest = preAdverseNoticeOn ? addWeekdays(preAdverseNoticeOn, 5) : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(() =>
      saveBackgroundCheck({
        checkId: check.id,
        patch: {
          status,
          vendor: vendor || null,
          vendorReference: vendorReference || null,
          requestedOn: requestedOn || null,
          completedOn: completedOn || null,
          preAdverseNoticeOn: preAdverseNoticeOn || null,
          finalAdverseOn: finalAdverseOn || null,
          note: note || null,
        },
      }),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{CHECK_TYPE_LABELS[check.checkType]}</span>
        <Badge variant={check.open ? "secondary" : "outline"}>{check.open ? "Open" : CHECK_STATUS_LABELS[check.status]}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {Object.entries(CHECK_STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Vendor">
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="Vendor reference">
          <Input value={vendorReference} onChange={(e) => setVendorReference(e.target.value)} />
        </Field>
        <Field label="Requested on">
          <Input type="date" value={requestedOn} onChange={(e) => setRequestedOn(e.target.value)} />
        </Field>
        <Field label="Completed on">
          <Input type="date" value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} />
        </Field>
        <Field
          label="Pre-adverse notice sent on"
          hint={preAdverseLocked ? "Set once; only an Admin can change it." : earliest ? `A background-based decision can be recorded from ${formatCalendarDate(earliest)}.` : "Starts the 5-weekday wait."}
        >
          <Input type="date" value={preAdverseNoticeOn} disabled={preAdverseLocked} onChange={(e) => setPreAdverseNoticeOn(e.target.value)} />
        </Field>
        <Field label="Final adverse notice on">
          <Input type="date" value={finalAdverseOn} onChange={(e) => setFinalAdverseOn(e.target.value)} />
        </Field>
      </div>
      <Field label="Status note" hint="Status only. Never report contents, SSN or date of birth.">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-14" />
      </Field>
      <ActionNotice failure={failure} />
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          Save check
        </Button>
      </div>
    </form>
  );
}
