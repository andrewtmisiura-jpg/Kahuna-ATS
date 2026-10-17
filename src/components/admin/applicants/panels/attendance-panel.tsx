import Link from "next/link";
import { arrivalLabel, formatDateTime, formatMobile } from "@/components/admin/applicants/format";
import { SuggestionButtons, UnmatchButton } from "@/components/admin/sessions/attendance-controls";
import { formatTime, matchedHow, SUGGESTION_LABELS } from "@/components/admin/sessions/format";
import { MarkCounts, MarksList } from "@/components/admin/sessions/marks";
import { db } from "@/db";
import { loadApplicationAttendance, type AttendanceRow } from "@/server/services/sessions/queries";
import { Section } from "../section";
import type { ProfilePanelProps } from "./types";

// Group interview attendance (Phase 2, sessions): the sessions this applicant was signed
// in at, from the paper sheet or the door check-in, with the stars and concerns staff
// gave them and any name match waiting for a person to confirm. Every staff role sees
// it; Viewers get no mobile numbers and no buttons. Renders nothing when the
// application is on no session's list and no row there may be this person.
export async function AttendancePanel({ applicationId, user, canAct }: ProfilePanelProps) {
  const attendance = await loadApplicationAttendance(db, applicationId, user.role);
  if (!attendance) return null;
  const suggestions = canAct ? attendance.suggestions : [];
  if (attendance.rows.length === 0 && suggestions.length === 0) return null;

  return (
    <Section title="Group interview">
      <div className="grid gap-3">
        {attendance.rows.length > 0 ? (
          <p>
            <span className="text-muted-foreground">Arrival:</span> {arrivalLabel(attendance.arrival)}
          </p>
        ) : null}
        {attendance.rows.map((row) => (
          <div key={row.attendeeId} className="grid gap-1.5 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              {canAct ? (
                <Link href={`/admin/sessions/${row.sessionId}`} className="font-medium underline-offset-4 hover:underline">
                  {formatDateTime(row.startsAt)}, {row.locationName}
                </Link>
              ) : (
                <span className="font-medium">
                  {formatDateTime(row.startsAt)}, {row.locationName}
                </span>
              )}
              <MarkCounts marks={row.marks} />
            </div>
            <p className="text-xs text-muted-foreground">
              {howTheyCame(row)}
              {row.sessionStatus === "canceled" ? " The session was canceled." : null}
            </p>
            {row.marks.length === 0 ? <p className="text-muted-foreground">No stars or concerns.</p> : <MarksList marks={row.marks} showTime />}
            {canAct ? <UnmatchButton attendeeId={row.attendeeId} nameAsWritten={row.nameAsWritten} /> : null}
          </div>
        ))}
        {suggestions.map((s) => (
          <div key={s.attendeeId} className="grid gap-1.5 rounded-md border border-dashed p-3">
            <p>
              Might be &ldquo;{s.nameAsWritten}&rdquo; on the list for{" "}
              <Link href={`/admin/sessions/${s.sessionId}`} className="underline underline-offset-4">
                {formatDateTime(s.startsAt)}, {s.locationName}
              </Link>{" "}
              <span className="text-muted-foreground">({SUGGESTION_LABELS[s.kind]})</span>
            </p>
            <SuggestionButtons attendeeId={s.attendeeId} applicationId={s.applicationId} />
          </div>
        ))}
      </div>
    </Section>
  );
}

// "Checked in at the door at 5:58 PM as "Jon Smith", (612) 555-0123. Matched by phone."
function howTheyCame(row: AttendanceRow): string {
  const came =
    row.source === "door_checkin"
      ? `Checked in at the door at ${formatTime(row.createdAt)}`
      : row.source === "paper_sheet"
        ? "On the sign-up sheet"
        : "Added by staff";
  const how = matchedHow(row.method, row.matchedByName);
  return `${came} as "${row.nameAsWritten}"${row.mobile ? `, ${formatMobile(row.mobile)}` : ""}. ${how[0]!.toUpperCase()}${how.slice(1)}.`;
}
