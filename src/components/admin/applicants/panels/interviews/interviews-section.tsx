"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INTERVIEW_CATEGORIES } from "@/server/services/interviews/categories";
import type { InterviewView, StaffChoice } from "@/server/services/interviews/interviews";
import { Empty, Rows, Section } from "../../section";
import { CancelDialog, ResultDialog, ScheduleDialog } from "./interview-dialogs";
import { BOOKED_VIA_LABELS, formatWhen, GRADE_LABELS, KIND_LABELS, RECOMMENDATION_LABELS, staffName, STATUS_LABELS, TAP } from "./labels";

// Interviews on the profile: each one-on-one or phone screen with its time, how it was
// booked, the interviewer and, once held, the grades, overall grade, recommendation,
// notes and Notion link. Hiring Managers and Admins schedule, reschedule, cancel and
// record results; Viewers read. A no-show only points at the Close button: nothing
// here closes an application.

type Props = {
  applicationId: string;
  applicationStatus: "open" | "hired" | "closed";
  interviews: InterviewView[];
  interviewers: StaffChoice[];
  canAct: boolean;
  currentUserId: string;
  // The withdraw reason the Close dialog offers for a missed one-on-one, if the role has it.
  noShowReason: string | null;
};

type Dialog = { kind: "schedule" } | { kind: "reschedule" | "cancel" | "result"; interview: InterviewView } | null;

export function InterviewsSection({ applicationId, applicationStatus, interviews, interviewers, canAct, currentUserId, noShowReason }: Props) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const closed = applicationStatus === "closed";
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <Section title="Interviews">
      <div className="grid gap-3">
        {interviews.length === 0 ? <Empty>No one-on-one or phone screen yet.</Empty> : null}
        {interviews.map((interview) => (
          <InterviewCard
            key={interview.id}
            interview={interview}
            canAct={canAct}
            closed={closed}
            noShowReason={noShowReason}
            onAction={(kind) => setDialog({ kind, interview })}
          />
        ))}
        {canAct ? (
          closed ? (
            <p className="text-xs text-muted-foreground">This application is closed. Reopen it to schedule an interview.</p>
          ) : (
            <div>
              <Button className={TAP} variant={interviews.length === 0 ? "default" : "outline"} onClick={() => setDialog({ kind: "schedule" })}>
                Schedule an interview
              </Button>
            </div>
          )
        ) : null}
      </div>

      {canAct ? (
        <>
          <ScheduleDialog
            open={dialog?.kind === "schedule" || dialog?.kind === "reschedule"}
            onOpenChange={close}
            applicationId={applicationId}
            interview={dialog?.kind === "reschedule" ? dialog.interview : undefined}
            interviewers={interviewers}
            currentUserId={currentUserId}
          />
          {dialog?.kind === "cancel" ? <CancelDialog open onOpenChange={close} interview={dialog.interview} /> : null}
          {dialog?.kind === "result" ? <ResultDialog open onOpenChange={close} interview={dialog.interview} /> : null}
        </>
      ) : null}
    </Section>
  );
}

function InterviewCard({
  interview,
  canAct,
  closed,
  noShowReason,
  onAction,
}: {
  interview: InterviewView;
  canAct: boolean;
  closed: boolean;
  noShowReason: string | null;
  onAction: (kind: "reschedule" | "cancel" | "result") => void;
}) {
  const { status } = interview;
  // The current scorecard in order, then any grade kept from an older one under its key.
  const grades = [
    ...INTERVIEW_CATEGORIES.filter((c) => interview.grades[c.key]).map((c) => ({ key: c.key, label: c.label, grade: interview.grades[c.key]! })),
    ...Object.entries(interview.grades)
      .filter(([key]) => !INTERVIEW_CATEGORIES.some((c) => c.key === key))
      .map(([key, grade]) => ({ key, label: key.replaceAll("_", " "), grade })),
  ];

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{KIND_LABELS[interview.kind]}</span>
        <Badge variant={status === "held" ? "secondary" : status === "no_show" ? "destructive" : "outline"}>{STATUS_LABELS[status]}</Badge>
      </div>
      <Rows
        items={[
          { label: status === "scheduled" ? "When" : "Booked for", value: formatWhen(interview.scheduledAt) || null },
          ...(status === "held" ? [{ label: "Held on", value: formatWhen(interview.heldAt) }] : []),
          { label: "Booked by", value: interview.bookedVia ? BOOKED_VIA_LABELS[interview.bookedVia] : null },
          { label: "Interviewer", value: staffName(interview.interviewer) || null },
          ...(status === "held"
            ? [
                { label: "Overall grade", value: interview.overallGrade ? GRADE_LABELS[interview.overallGrade] : null },
                { label: "Recommendation", value: interview.recommendation ? RECOMMENDATION_LABELS[interview.recommendation] : null },
              ]
            : []),
        ]}
      />
      {grades.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-3" aria-label="Grades">
          {grades.map((g) => (
            <li key={g.key} className="flex justify-between gap-2 rounded bg-muted/40 px-2 py-1">
              <span className="text-muted-foreground">{g.label}</span>
              <span className="font-medium">{GRADE_LABELS[g.grade]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {interview.notes ? <p className="whitespace-pre-wrap text-sm">{interview.notes}</p> : null}
      {interview.notionUrl ? (
        <a href={interview.notionUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
          Open the Notion page
        </a>
      ) : null}

      {status === "no_show" && !closed ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {noShowReason
            ? `If they are not coming back, tap Close at the top of the profile, pick Withdrew and the reason "${noShowReason}".`
            : "If they are not coming back, tap Close at the top of the profile and pick Withdrew."}{" "}
          Nothing closes on its own.
        </p>
      ) : null}
      {status === "scheduled" && closed ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This application is closed but the interview is still scheduled. Cancel it if it is not happening, or record how it went.
        </p>
      ) : null}

      {canAct && status !== "canceled" ? (
        <div className="flex flex-wrap gap-2">
          {status === "scheduled" ? (
            <>
              <Button className={TAP} size="sm" onClick={() => onAction("result")}>
                Record result
              </Button>
              {!closed ? (
                <Button className={TAP} size="sm" variant="outline" onClick={() => onAction("reschedule")}>
                  Reschedule
                </Button>
              ) : null}
              <Button className={TAP} size="sm" variant="outline" onClick={() => onAction("cancel")}>
                Cancel
              </Button>
            </>
          ) : (
            <Button className={TAP} size="sm" variant="outline" onClick={() => onAction("result")}>
              Edit result
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
