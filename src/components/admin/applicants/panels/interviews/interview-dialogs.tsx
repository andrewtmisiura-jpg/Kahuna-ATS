"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { InterviewBookedVia, InterviewGrade, InterviewKind, InterviewRecommendation } from "@/db/schema";
import { cancelInterviewAction, recordInterviewResultAction, rescheduleInterviewAction, scheduleInterviewAction } from "@/server/actions/admin/interviews";
import { INTERVIEW_CATEGORIES } from "@/server/services/interviews/categories";
import type { InterviewView, StaffChoice } from "@/server/services/interviews/interviews";
import { centralDate } from "@/server/services/time";
import { ActionNotice, Field, NativeSelect, Textarea } from "../../fields";
import { useAdminAction } from "../../use-admin-action";
import { BOOKED_VIA_LABELS, centralInputs, GRADE_LABELS, GRADE_OPTIONS, KIND_LABELS, NO_MEDICAL, RECOMMENDATION_LABELS, staffName, TAP } from "./labels";

// The interview dialogs: schedule or reschedule (kind, Central date and time, how it
// was booked, interviewer), cancel, and the result (held or no-show, grades, overall
// grade, recommendation, notes and the Notion link).

type OpenProps = { open: boolean; onOpenChange: (open: boolean) => void };

function Choice({ name, checked, onChange, label }: { name: string; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Schedule and reschedule

type ScheduleProps = OpenProps & {
  applicationId: string;
  // Present to reschedule.
  interview?: InterviewView;
  interviewers: StaffChoice[];
  currentUserId: string;
};

export function ScheduleDialog(props: ScheduleProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <ScheduleForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function ScheduleForm({ onOpenChange, applicationId, interview, interviewers, currentUserId }: ScheduleProps) {
  const start = interview?.scheduledAt ? centralInputs(interview.scheduledAt) : { date: centralDate(new Date()), time: "10:00" };
  const [kind, setKind] = useState<InterviewKind>(interview?.kind ?? "one_on_one");
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [bookedVia, setBookedVia] = useState<InterviewBookedVia | "">(interview ? (interview.bookedVia ?? "") : "booking_link");
  const [interviewerUserId, setInterviewerUserId] = useState(
    interview ? (interview.interviewer?.id ?? "") : interviewers.some((u) => u.id === currentUserId) ? currentUserId : "",
  );
  const { run, pending, failure } = useAdminAction();
  const name = useId();
  // A disabled interviewer stays on an interview booked earlier, so keep them in the list.
  const choices = interview?.interviewer && !interviewers.some((u) => u.id === interview.interviewer!.id) ? [interview.interviewer, ...interviewers] : interviewers;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = { kind, date, time, bookedVia: bookedVia || null, interviewerUserId: interviewerUserId || null };
    const done = () => onOpenChange(false);
    if (interview) run(() => rescheduleInterviewAction({ interviewId: interview.id, ...fields }), done);
    else run(() => scheduleInterviewAction({ applicationId, ...fields }), done);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{interview ? "Reschedule" : "Schedule an interview"}</DialogTitle>
        <DialogDescription>Times are Central time.</DialogDescription>
      </DialogHeader>
      <Field label="Kind" group>
        <div className="flex flex-wrap gap-x-4">
          {(Object.keys(KIND_LABELS) as InterviewKind[]).map((k) => (
            <Choice key={k} name={name} checked={kind === k} onChange={() => setKind(k)} label={KIND_LABELS[k]} />
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          <Input type="date" className={TAP} value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Time (Central)">
          <Input type="time" className={TAP} value={time} onChange={(e) => setTime(e.target.value)} required />
        </Field>
      </div>
      <Field label="Booked by">
        <NativeSelect className={TAP} value={bookedVia} onChange={(e) => setBookedVia(e.target.value as InterviewBookedVia | "")}>
          <option value="">Not recorded</option>
          {(Object.keys(BOOKED_VIA_LABELS) as InterviewBookedVia[]).map((b) => (
            <option key={b} value={b}>
              {BOOKED_VIA_LABELS[b]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Interviewer">
        <NativeSelect className={TAP} value={interviewerUserId} onChange={(e) => setInterviewerUserId(e.target.value)}>
          <option value="">Not decided yet</option>
          {choices.map((u) => (
            <option key={u.id} value={u.id}>
              {staffName(u)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" className={TAP} onClick={() => onOpenChange(false)}>
          Back
        </Button>
        <Button type="submit" className={TAP} disabled={pending || !date || !time}>
          {interview ? "Save new time" : "Schedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Cancel

export function CancelDialog({ open, onOpenChange, interview }: OpenProps & { interview: InterviewView }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open ? <CancelBody onOpenChange={onOpenChange} interview={interview} /> : null}</DialogContent>
    </Dialog>
  );
}

function CancelBody({ onOpenChange, interview }: { onOpenChange: (open: boolean) => void; interview: InterviewView }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Cancel this {KIND_LABELS[interview.kind].toLowerCase()}?</DialogTitle>
        <DialogDescription>It stays on the profile as canceled. If they missed it, record a no-show instead.</DialogDescription>
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
          onClick={() => run(() => cancelInterviewAction({ interviewId: interview.id }), () => onOpenChange(false))}
        >
          Cancel interview
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Result

type ResultProps = OpenProps & { interview: InterviewView };

export function ResultDialog(props: ResultProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <ResultForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function ResultForm({ onOpenChange, interview }: ResultProps) {
  // Held defaults to the booked time once it has passed, else to now.
  const heldDefault = interview.heldAt ?? (interview.scheduledAt && new Date(interview.scheduledAt) <= new Date() ? interview.scheduledAt : new Date());
  const start = centralInputs(heldDefault);
  const [outcome, setOutcome] = useState<"held" | "no_show">(interview.status === "no_show" ? "no_show" : "held");
  const [heldDate, setHeldDate] = useState(start.date);
  const [heldTime, setHeldTime] = useState(start.time);
  const [grades, setGrades] = useState<Record<string, InterviewGrade | "">>(() =>
    Object.fromEntries(INTERVIEW_CATEGORIES.map((c) => [c.key, interview.grades[c.key] ?? ""])),
  );
  const [overallGrade, setOverallGrade] = useState<InterviewGrade | "">(interview.overallGrade ?? "");
  const [recommendation, setRecommendation] = useState<InterviewRecommendation | "">(interview.recommendation ?? "");
  const [notes, setNotes] = useState(interview.notes ?? "");
  const [notionUrl, setNotionUrl] = useState(interview.notionUrl ?? "");
  const { run, pending, failure } = useAdminAction();
  const outcomeName = useId();
  const recommendationName = useId();
  const held = outcome === "held";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () =>
        recordInterviewResultAction({
          interviewId: interview.id,
          outcome,
          heldDate: held ? heldDate : null,
          heldTime: held ? heldTime : null,
          grades: held ? Object.fromEntries(Object.entries(grades).map(([key, grade]) => [key, grade || null])) : {},
          overallGrade: held ? overallGrade || null : null,
          recommendation: held ? recommendation || null : null,
          notes: notes || null,
          notionUrl: notionUrl || null,
        }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>How did the {KIND_LABELS[interview.kind].toLowerCase()} go?</DialogTitle>
        <DialogDescription>Grades go from A+ to F. Leave a category blank if it did not come up.</DialogDescription>
      </DialogHeader>
      <Field label="Result" group>
        <div className="flex flex-wrap gap-x-4">
          <Choice name={outcomeName} checked={held} onChange={() => setOutcome("held")} label="Held" />
          <Choice name={outcomeName} checked={!held} onChange={() => setOutcome("no_show")} label="No-show" />
        </div>
      </Field>
      {held ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Held on">
              <Input type="date" className={TAP} value={heldDate} onChange={(e) => setHeldDate(e.target.value)} required />
            </Field>
            <Field label="At (Central)">
              <Input type="time" className={TAP} value={heldTime} onChange={(e) => setHeldTime(e.target.value)} required />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {INTERVIEW_CATEGORIES.map((category) => (
              <Field key={category.key} label={category.label}>
                <NativeSelect
                  className={TAP}
                  value={grades[category.key] ?? ""}
                  onChange={(e) => setGrades((prev) => ({ ...prev, [category.key]: e.target.value as InterviewGrade | "" }))}
                >
                  <option value="">Not graded</option>
                  {GRADE_OPTIONS.map((g) => (
                    <option key={g} value={g}>
                      {GRADE_LABELS[g]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ))}
          </div>
          <Field label="Overall grade">
            <NativeSelect className={TAP} value={overallGrade} onChange={(e) => setOverallGrade(e.target.value as InterviewGrade | "")}>
              <option value="">Not graded</option>
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {GRADE_LABELS[g]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Recommendation" group>
            <div className="flex flex-wrap gap-x-4">
              {(Object.keys(RECOMMENDATION_LABELS) as InterviewRecommendation[]).map((r) => (
                <Choice key={r} name={recommendationName} checked={recommendation === r} onChange={() => setRecommendation(r)} label={RECOMMENDATION_LABELS[r]} />
              ))}
              <Choice name={recommendationName} checked={recommendation === ""} onChange={() => setRecommendation("")} label="Not decided" />
            </div>
          </Field>
        </>
      ) : (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          A no-show has no grades. Saving it does not close the application.
        </p>
      )}
      <Field label="Notes" hint={NO_MEDICAL}>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
      </Field>
      <Field label="Notion link (optional)" hint="A notion.so or notion.site page, starting with https://">
        <Input type="url" inputMode="url" className={TAP} placeholder="https://www.notion.so/..." value={notionUrl} onChange={(e) => setNotionUrl(e.target.value)} />
      </Field>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" className={TAP} onClick={() => onOpenChange(false)}>
          Back
        </Button>
        <Button type="submit" className={TAP} disabled={pending || (held && (!heldDate || !heldTime))}>
          Save result
        </Button>
      </DialogFooter>
    </form>
  );
}
