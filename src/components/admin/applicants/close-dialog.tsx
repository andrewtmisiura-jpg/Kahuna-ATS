"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closeApplication } from "@/server/actions/admin/applications";
import type { PicklistItem, ProfileCheck } from "@/server/services/applications/queries";
import { addWeekdays } from "@/server/services/time";
import { ActionNotice, CheckboxRow, Field, NativeSelect, OccurredAtField, Textarea } from "./fields";
import { CHECK_STATUS_LABELS, CHECK_TYPE_LABELS, formatCalendarDate } from "./format";
import { useAdminAction } from "./use-admin-action";

// The Close dialog: outcome, a reason from the matching list, a note, and the
// FCRA controls whenever a background check is open (PLAN.md, Decisions 12).

type Outcome = "disqualified" | "withdrew" | "not_selected";

const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  { value: "disqualified", label: "Disqualified", hint: "Something about this person does not fit the job." },
  { value: "not_selected", label: "Not selected", hint: "A fine applicant we did not have room for." },
  { value: "withdrew", label: "Withdrew", hint: "They pulled out, stopped responding or declined." },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; eventSeq: number };
  picklists: { disqualify: PicklistItem[]; withdraw: PicklistItem[]; notSelected: PicklistItem[] };
  checks: ProfileCheck[];
};

export function CloseDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <CloseForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function CloseForm({ onOpenChange, application, picklists, checks }: Props) {
  const [outcome, setOutcome] = useState<Outcome>("disqualified");
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | undefined>(undefined);
  const [reliedOn, setReliedOn] = useState<string[]>([]);
  const [notReportBased, setNotReportBased] = useState(false);
  const { run, pending, failure } = useAdminAction();

  const openChecks = useMemo(() => checks.filter((c) => c.open), [checks]);
  const reasons = outcome === "disqualified" ? picklists.disqualify : outcome === "withdrew" ? picklists.withdraw : picklists.notSelected;
  const reason = reasons.find((r) => r.id === reasonId);
  const backgroundBased = Boolean(reason?.fcraAdverse);
  const needsStatement = openChecks.length > 0 && outcome !== "withdrew" && !backgroundBased;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () =>
        closeApplication({
          applicationId: application.id,
          expectedSeq: application.eventSeq,
          outcome,
          reasonOptionId: reasonId,
          note: note || null,
          occurredAt,
          fcra: backgroundBased ? { backgroundCheckIds: reliedOn } : needsStatement ? { notReportBased } : undefined,
        }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Close</DialogTitle>
        <DialogDescription>Pick the outcome and the real reason. The reason feeds the reports.</DialogDescription>
      </DialogHeader>

      {openChecks.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">A background check is open.</p>
          <ul className="mt-1 list-disc pl-5">
            {openChecks.map((c) => (
              <li key={c.id}>
                {CHECK_TYPE_LABELS[c.checkType]}: {CHECK_STATUS_LABELS[c.status]}
                {c.preAdverseNoticeOn ? `, pre-adverse notice ${formatCalendarDate(c.preAdverseNoticeOn)}` : ", no pre-adverse notice yet"}
              </li>
            ))}
          </ul>
          <p className="mt-1">A background-based reason needs the pre-adverse notice out for 5 weekdays. Any other reason needs the statement below.</p>
        </div>
      ) : null}

      <Field label="Outcome" group>
        <div className="grid gap-2">
          {OUTCOMES.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="outcome"
                className="mt-1"
                checked={outcome === o.value}
                onChange={() => {
                  setOutcome(o.value);
                  setReasonId("");
                }}
              />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Reason">
        <NativeSelect value={reasonId} onChange={(e) => setReasonId(e.target.value)} required>
          <option value="">Pick a reason</option>
          {reasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {backgroundBased ? (
        <Field label="This decision relies on" group hint="Pick the check or checks the decision is based on.">
          {checks.length === 0 ? <p className="text-sm text-destructive">There is no background check on this application.</p> : null}
          {checks.map((c) => {
            const earliest = c.preAdverseNoticeOn ? addWeekdays(c.preAdverseNoticeOn, 5) : null;
            return (
              <CheckboxRow
                key={c.id}
                label={`${CHECK_TYPE_LABELS[c.checkType]} (${CHECK_STATUS_LABELS[c.status]})`}
                hint={earliest ? `Pre-adverse notice ${formatCalendarDate(c.preAdverseNoticeOn)}; can be recorded from ${formatCalendarDate(earliest)}` : "No pre-adverse notice date yet: record it on the check first"}
                checked={reliedOn.includes(c.id)}
                onChange={(on) => setReliedOn((prev) => (on ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
              />
            );
          })}
        </Field>
      ) : null}

      {needsStatement ? (
        <CheckboxRow
          label="This decision does not rely on the background report."
          hint="Recorded with your name in the audit log."
          checked={notReportBased}
          onChange={setNotReportBased}
        />
      ) : null}

      <OccurredAtField value={occurredAt} onChange={setOccurredAt} />

      <Field label={reason?.requiresNote ? "Note (required for this reason)" : "Note (optional)"}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={reason?.requiresNote} />
      </Field>

      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending || !reasonId || (needsStatement && !notReportBased) || (backgroundBased && reliedOn.length === 0)}>
          {pending ? "Closing" : "Close application"}
        </Button>
      </DialogFooter>
    </form>
  );
}
