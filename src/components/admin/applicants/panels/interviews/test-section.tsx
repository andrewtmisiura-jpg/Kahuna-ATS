"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AssessmentResult } from "@/db/schema";
import { recordAssessmentAction, voidAssessmentAction } from "@/server/actions/admin/interviews";
import type { AssessmentView } from "@/server/services/assessments/assessments";
import type { TestBlock } from "@/server/services/interviews/panel";
import { centralDate } from "@/server/services/time";
import { ActionNotice, Field, Textarea } from "../../fields";
import { formatCalendarDate } from "../../format";
import { Empty, Rows, Section } from "../../section";
import { useAdminAction } from "../../use-admin-action";
import { NO_MEDICAL, RESULT_LABELS, staffName, TAP } from "./labels";

// One test the role uses, such as the ladder test: the live result with the date and
// who gave it, or the form to record it. A correction voids the result, which stays
// in the history crossed out, and the test is recorded again. The note is restricted:
// Viewers never receive it. A fail only points at the Close button.

type Props = {
  applicationId: string;
  applicationStatus: "open" | "hired" | "closed";
  block: TestBlock;
  canAct: boolean;
  // The disqualify reason the Close dialog offers for a failed ladder test, if the role has it.
  failedTestReason: string | null;
};

export function TestSection({ applicationId, applicationStatus, block, canAct, failedTestReason }: Props) {
  const { type, live, voided } = block;
  const [voiding, setVoiding] = useState(false);

  return (
    <Section title={type.label}>
      <div className="grid gap-3">
        {live ? (
          <div className="grid gap-2">
            <Rows
              items={[
                { label: "Result", value: <span className="font-medium">{RESULT_LABELS[live.result]}</span> },
                { label: "Date", value: formatCalendarDate(live.administeredOn) },
                { label: "Given by", value: staffName(live.administeredBy) },
              ]}
            />
            {live.note ? (
              <div className="grid gap-1 rounded-md border p-2 text-sm">
                <Badge variant="outline">Restricted</Badge>
                <p className="whitespace-pre-wrap">{live.note}</p>
              </div>
            ) : null}
            {live.result === "fail" && applicationStatus === "open" ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {type.key === "ladder_test" && failedTestReason
                  ? `To close the application, tap Close at the top of the profile, pick Disqualified and the reason "${failedTestReason}".`
                  : "To close the application, tap Close at the top of the profile and pick the reason that fits."}{" "}
                Nothing closes on its own.
              </p>
            ) : null}
            {canAct ? (
              <div>
                <Button className={TAP} size="sm" variant="outline" onClick={() => setVoiding(true)}>
                  Void this result
                </Button>
              </div>
            ) : null}
          </div>
        ) : canAct && !type.archivedAt ? (
          <RecordForm applicationId={applicationId} typeId={type.id} label={type.label} />
        ) : (
          <Empty>Not recorded yet.</Empty>
        )}

        {voided.length > 0 ? (
          <div className="grid gap-1 text-xs text-muted-foreground">
            <span>Voided</span>
            <ul className="grid gap-1">
              {voided.map((r) => (
                <li key={r.id} className="line-through">
                  {RESULT_LABELS[r.result]}, {formatCalendarDate(r.administeredOn)}, {staffName(r.administeredBy)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {live && canAct ? <VoidDialog open={voiding} onOpenChange={setVoiding} result={live} label={type.label} /> : null}
    </Section>
  );
}

function RecordForm({ applicationId, typeId, label }: { applicationId: string; typeId: string; label: string }) {
  const [result, setResult] = useState<AssessmentResult | "">("");
  const [administeredOn, setAdministeredOn] = useState(() => centralDate(new Date()));
  const [note, setNote] = useState("");
  const { run, pending, failure } = useAdminAction();
  const name = useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!result) return;
    run(
      () => recordAssessmentAction({ applicationId, assessmentTypeOptionId: typeId, result, administeredOn, note: note || null }),
      () => {
        setResult("");
        setNote("");
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field label="Result" group>
        <div className="flex flex-wrap gap-x-4">
          {(Object.keys(RESULT_LABELS) as AssessmentResult[]).map((r) => (
            <label key={r} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
              <input type="radio" name={name} checked={result === r} onChange={() => setResult(r)} />
              {RESULT_LABELS[r]}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Date of the test">
        <Input type="date" className={TAP} value={administeredOn} max={centralDate(new Date())} onChange={(e) => setAdministeredOn(e.target.value)} required />
      </Field>
      <Field label="Note (restricted, optional)" hint={`Only Admins and Hiring Managers see it. ${NO_MEDICAL}`}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-14" />
      </Field>
      <p className="text-xs text-muted-foreground">Saved as given by you.</p>
      <ActionNotice failure={failure} />
      <div>
        <Button type="submit" className={TAP} disabled={pending || !result || !administeredOn}>
          Save {label.toLowerCase()} result
        </Button>
      </div>
    </form>
  );
}

function VoidDialog({ open, onOpenChange, result, label }: { open: boolean; onOpenChange: (open: boolean) => void; result: AssessmentView; label: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open ? <VoidBody onOpenChange={onOpenChange} result={result} label={label} /> : null}</DialogContent>
    </Dialog>
  );
}

function VoidBody({ onOpenChange, result, label }: { onOpenChange: (open: boolean) => void; result: AssessmentView; label: string }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Void this {label.toLowerCase()} result?</DialogTitle>
        <DialogDescription>
          {RESULT_LABELS[result.result]} on {formatCalendarDate(result.administeredOn)} stays in the history, crossed out, and you can record the test again.
        </DialogDescription>
      </DialogHeader>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" className={TAP} onClick={() => onOpenChange(false)}>
          Keep it
        </Button>
        <Button
          type="button"
          variant="destructive"
          className={TAP}
          disabled={pending}
          onClick={() => run(() => voidAssessmentAction({ assessmentId: result.id }), () => onOpenChange(false))}
        >
          Void result
        </Button>
      </DialogFooter>
    </>
  );
}
