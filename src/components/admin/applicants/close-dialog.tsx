"use client";

import { useId, useMemo, useState } from "react";
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
// The outcome, reason and FCRA pieces are shared with the Rescind hire dialog.

export type Outcome = "disqualified" | "withdrew" | "not_selected";

const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  { value: "disqualified", label: "Disqualified", hint: "Something about this person does not fit the job." },
  { value: "not_selected", label: "Not selected", hint: "A fine applicant we did not have room for." },
  { value: "withdrew", label: "Withdrew", hint: "They pulled out, stopped responding or declined." },
];

export type ClosePicklists = { disqualify: PicklistItem[]; withdraw: PicklistItem[]; notSelected: PicklistItem[] };

// The state behind the outcome, reason and FCRA fields, and what they add up to.
export function useCloseChoice(picklists: ClosePicklists, checks: ProfileCheck[], initial: Outcome = "disqualified") {
  const [outcome, setOutcomeState] = useState<Outcome>(initial);
  const [reasonId, setReasonId] = useState("");
  const [reliedOn, setReliedOn] = useState<string[]>([]);
  const [notReportBased, setNotReportBased] = useState(false);

  const openChecks = useMemo(() => checks.filter((c) => c.open), [checks]);
  const reasons = outcome === "disqualified" ? picklists.disqualify : outcome === "withdrew" ? picklists.withdraw : picklists.notSelected;
  const reason = reasons.find((r) => r.id === reasonId);
  const backgroundBased = Boolean(reason?.fcraAdverse);
  const needsStatement = openChecks.length > 0 && outcome !== "withdrew" && !backgroundBased;
  const fcra = backgroundBased ? { backgroundCheckIds: reliedOn } : needsStatement ? { notReportBased } : undefined;
  const ready = Boolean(reasonId) && !(needsStatement && !notReportBased) && !(backgroundBased && reliedOn.length === 0);

  return {
    outcome,
    setOutcome: (value: Outcome) => {
      setOutcomeState(value);
      setReasonId("");
    },
    reasonId,
    setReasonId,
    reasons,
    reason,
    reliedOn,
    setReliedOn,
    notReportBased,
    setNotReportBased,
    checks,
    openChecks,
    backgroundBased,
    needsStatement,
    fcra,
    ready,
  };
}

export type CloseChoice = ReturnType<typeof useCloseChoice>;

export function OpenCheckWarning({ choice }: { choice: CloseChoice }) {
  if (choice.openChecks.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">A background check is open.</p>
      <ul className="mt-1 list-disc pl-5">
        {choice.openChecks.map((c) => (
          <li key={c.id}>
            {CHECK_TYPE_LABELS[c.checkType]}: {CHECK_STATUS_LABELS[c.status]}
            {c.preAdverseNoticeOn ? `, pre-adverse notice ${formatCalendarDate(c.preAdverseNoticeOn)}` : ", no pre-adverse notice yet"}
          </li>
        ))}
      </ul>
      <p className="mt-1">A background-based reason needs the pre-adverse notice out for 5 weekdays. Any other reason needs the statement below.</p>
    </div>
  );
}

// Outcome radios, the reason list for that outcome, and the FCRA controls.
export function OutcomeReasonFields({ choice }: { choice: CloseChoice }) {
  const name = useId();
  return (
    <>
      <Field label="Outcome" group>
        <div className="grid gap-2">
          {OUTCOMES.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input type="radio" name={name} className="mt-1" checked={choice.outcome === o.value} onChange={() => choice.setOutcome(o.value)} />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Reason">
        <NativeSelect value={choice.reasonId} onChange={(e) => choice.setReasonId(e.target.value)} required>
          <option value="">Pick a reason</option>
          {choice.reasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {choice.backgroundBased ? (
        <Field label="This decision relies on" group hint="Pick the check or checks the decision is based on.">
          {choice.checks.length === 0 ? <p className="text-sm text-destructive">There is no background check on this application.</p> : null}
          {choice.checks.map((c) => {
            const earliest = c.preAdverseNoticeOn ? addWeekdays(c.preAdverseNoticeOn, 5) : null;
            return (
              <CheckboxRow
                key={c.id}
                label={`${CHECK_TYPE_LABELS[c.checkType]} (${CHECK_STATUS_LABELS[c.status]})`}
                hint={
                  earliest
                    ? `Pre-adverse notice ${formatCalendarDate(c.preAdverseNoticeOn)}; can be recorded from ${formatCalendarDate(earliest)}`
                    : "No pre-adverse notice date yet: record it on the check first"
                }
                checked={choice.reliedOn.includes(c.id)}
                onChange={(on) => choice.setReliedOn((prev) => (on ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
              />
            );
          })}
        </Field>
      ) : null}

      {choice.needsStatement ? (
        <CheckboxRow
          label="This decision does not rely on the background report."
          hint="Recorded with your name in the audit log."
          checked={choice.notReportBased}
          onChange={choice.setNotReportBased}
        />
      ) : null}
    </>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; eventSeq: number };
  picklists: ClosePicklists;
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
  const choice = useCloseChoice(picklists, checks);
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | undefined>(undefined);
  const { run, pending, failure } = useAdminAction();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () =>
        closeApplication({
          applicationId: application.id,
          expectedSeq: application.eventSeq,
          outcome: choice.outcome,
          reasonOptionId: choice.reasonId,
          note: note || null,
          occurredAt,
          fcra: choice.fcra,
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

      <OpenCheckWarning choice={choice} />
      <OutcomeReasonFields choice={choice} />
      <OccurredAtField value={occurredAt} onChange={setOccurredAt} />

      <Field label={choice.reason?.requiresNote ? "Note (required for this reason)" : "Note (optional)"}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={choice.reason?.requiresNote} />
      </Field>

      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending || !choice.ready}>
          {pending ? "Closing" : "Close application"}
        </Button>
      </DialogFooter>
    </form>
  );
}
