"use client";

import { RefreshCw, Star, Tablet, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ActionNotice, Field } from "@/components/admin/applicants/fields";
import { formatDay, formatMobile, fullName } from "@/components/admin/applicants/format";
import { useAdminAction } from "@/components/admin/applicants/use-admin-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  addAttendeeAction,
  confirmMatchAction,
  dismissSuggestionAction,
  matchNowAction,
  removeAttendeeAction,
  unmatchAttendeeAction,
  updateAttendeeAction,
} from "@/server/actions/admin/attendees";
import type { MatchSuggestion } from "@/server/services/sessions/matching";
import type { LinkChoice, SessionAttendee } from "@/server/services/sessions/queries";
import { formatTime, matchedHow, SOURCE_LABELS, SUGGESTION_LABELS, TAP } from "./format";
import { MarkCounts, MarksList } from "./marks";

// Who came to a group interview, on the session page: type in the sign-up sheet one
// row after another on a phone, fix or remove a row, and match rows to applications.
// An exact mobile matches on its own; a name match waits here for "It's them" or
// "Not them"; anyone else can be linked by hand from the opening's applicants.

type StaffSource = "paper_sheet" | "staff_added";

export function AttendeesSection({
  sessionId,
  attendees,
  choices,
  canceled,
}: {
  sessionId: string;
  attendees: SessionAttendee[];
  choices: LinkChoice[];
  canceled: boolean;
}) {
  const { run, pending, failure } = useAdminAction();
  const [message, setMessage] = useState<string | null>(null);
  const matched = attendees.filter((a) => a.match).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who came</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{attendees.length}</span> on the list,{" "}
          <span className="font-medium text-foreground">{matched}</span> matched to an application. A mobile number that matches an
          applicant links them at once; people who apply later are matched each time this page opens.
        </CardDescription>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button asChild className={TAP}>
            <Link href={`/admin/sessions/${sessionId}/floor`}>
              <Star />
              Floor view
            </Link>
          </Button>
          <Button asChild variant="outline" className={TAP}>
            <Link href={`/check-in/${sessionId}`}>
              <Tablet />
              Door check-in
            </Link>
          </Button>
          <Button
            variant="outline"
            className={TAP}
            disabled={pending}
            onClick={() =>
              run(
                () => matchNowAction({ sessionId }),
                (data) => setMessage(data.linked === 0 ? "No new phone matches." : `Matched ${data.linked} by phone.`),
              )
            }
          >
            <RefreshCw />
            Match now
          </Button>
        </div>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
        <ActionNotice failure={failure} />
      </CardHeader>
      <CardContent className="grid gap-4">
        {canceled ? (
          <p className="text-sm text-muted-foreground">This session was canceled, so nobody can be added to it.</p>
        ) : (
          <AddAttendeeForm sessionId={sessionId} />
        )}
        {attendees.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody is on the list yet. Type in the sign-up sheet above, or hand a tablet with the door check-in to people as they arrive.
          </p>
        ) : (
          <ul className="grid gap-3" aria-label="People on the list">
            {attendees.map((a) => (
              <AttendeeItem key={a.id} attendee={a} choices={choices} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SourcePicker({ value, onChange }: { value: StaffSource; onChange: (value: StaffSource) => void }) {
  const options: { value: StaffSource; label: string }[] = [
    { value: "paper_sheet", label: "On the sign-up sheet" },
    { value: "staff_added", label: "Not on the sheet" },
  ];
  return (
    <div role="radiogroup" aria-label="Where this name comes from" className="flex flex-wrap gap-2">
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm sm:min-h-8",
            value === option.value && "border-primary bg-primary/5",
          )}
        >
          <input type="radio" checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

// Quick repeated entry: after each Add the fields clear and the name field takes the
// focus again, while the source stays as picked.
function AddAttendeeForm({ sessionId }: { sessionId: string }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [source, setSource] = useState<StaffSource>("paper_sheet");
  const [added, setAdded] = useState<string | null>(null);
  const { run, pending, failure } = useAdminAction();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = name.trim();
    run(
      () => addAttendeeAction({ sessionId, nameAsWritten: name, mobile: mobile.trim() || null, source }),
      (data) => {
        setName("");
        setMobile("");
        setAdded(data.matched ? `Added ${typed}, matched to their application by phone.` : `Added ${typed}.`);
        nameRef.current?.focus();
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-md border p-3" aria-label="Add from the sign-up sheet">
      <p className="text-sm font-medium">Add from the sign-up sheet</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field label="Name as written">
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            autoCapitalize="words"
            maxLength={120}
            className="h-11 sm:h-9"
          />
        </Field>
        <Field label="Mobile (optional)">
          <Input
            type="tel"
            inputMode="tel"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            autoComplete="off"
            maxLength={40}
            className="h-11 sm:h-9"
          />
        </Field>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending || !name.trim()}>
          <UserPlus />
          {pending ? "Adding" : "Add"}
        </Button>
      </div>
      <SourcePicker value={source} onChange={setSource} />
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {added}
      </p>
      <ActionNotice failure={failure} />
    </form>
  );
}

function AttendeeItem({ attendee, choices }: { attendee: SessionAttendee; choices: LinkChoice[] }) {
  const [mode, setMode] = useState<"view" | "edit" | "link">("view");
  const { run, pending, failure } = useAdminAction();
  const where = SOURCE_LABELS[attendee.source] + (attendee.source === "door_checkin" ? ` at ${formatTime(attendee.createdAt)}` : "");

  return (
    <li className="grid gap-2 rounded-md border p-3" aria-label={attendee.nameAsWritten}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{attendee.nameAsWritten}</p>
          <p className="text-xs text-muted-foreground">
            {attendee.mobile ? formatMobile(attendee.mobile) : "No mobile"} · {where}
          </p>
        </div>
        <MarkCounts marks={attendee.marks} />
      </div>

      {attendee.match ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>
            Applied:{" "}
            <Link href={`/admin/applicants/${attendee.match.applicationId}`} className="font-medium underline underline-offset-4">
              {fullName(attendee.match.firstName, attendee.match.lastName)}
            </Link>{" "}
            <span className="text-muted-foreground">({matchedHow(attendee.match.method, attendee.match.matchedByName)})</span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={TAP}
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Unmatch ${attendee.nameAsWritten} from this application? They will not be matched to it again on their own.`)) {
                run(() => unmatchAttendeeAction({ attendeeId: attendee.id }));
              }
            }}
          >
            Unmatch
          </Button>
        </div>
      ) : attendee.suggestions.length > 0 ? (
        <Suggestions attendeeId={attendee.id} suggestions={attendee.suggestions} />
      ) : (
        <p className="text-sm text-muted-foreground">No application matched yet.</p>
      )}

      <MarksList marks={attendee.marks} />

      {mode === "edit" ? <EditAttendee attendee={attendee} onDone={() => setMode("view")} /> : null}
      {mode === "link" ? <LinkPicker attendee={attendee} choices={choices} onDone={() => setMode("view")} /> : null}

      {mode === "view" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className={TAP} onClick={() => setMode("edit")}>
            Edit
          </Button>
          {!attendee.match ? (
            <Button type="button" size="sm" variant="outline" className={TAP} onClick={() => setMode("link")}>
              Link to an applicant
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={TAP}
            disabled={pending}
            onClick={() => {
              const marks = attendee.marks.length > 0 ? " Their stars and concerns stop showing too." : "";
              if (window.confirm(`Remove ${attendee.nameAsWritten} from this session's list?${marks}`)) {
                run(() => removeAttendeeAction({ attendeeId: attendee.id }));
              }
            }}
          >
            Remove
          </Button>
        </div>
      ) : null}
      <ActionNotice failure={failure} />
    </li>
  );
}

function Suggestions({ attendeeId, suggestions }: { attendeeId: string; suggestions: MatchSuggestion[] }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <div className="grid gap-2 rounded-md bg-muted/40 p-2 text-sm">
      <p className="font-medium">Might be:</p>
      {suggestions.map((s) => (
        <div key={s.applicationId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0">
            <Link href={`/admin/applicants/${s.applicationId}`} className="font-medium underline underline-offset-4">
              {fullName(s.firstName, s.lastName)}
            </Link>{" "}
            <span className="text-muted-foreground">
              ({SUGGESTION_LABELS[s.kind]}; started {formatDay(s.startedAt)}
              {s.mobile ? `; mobile ${formatMobile(s.mobile)}` : ""})
            </span>
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className={TAP}
              disabled={pending}
              onClick={() => run(() => confirmMatchAction({ attendeeId, applicationId: s.applicationId }))}
            >
              It&apos;s them
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={TAP}
              disabled={pending}
              onClick={() => run(() => dismissSuggestionAction({ attendeeId, applicationId: s.applicationId }))}
            >
              Not them
            </Button>
          </span>
        </div>
      ))}
      <ActionNotice failure={failure} />
    </div>
  );
}

function EditAttendee({ attendee, onDone }: { attendee: SessionAttendee; onDone: () => void }) {
  const [name, setName] = useState(attendee.nameAsWritten);
  const [mobile, setMobile] = useState(formatMobile(attendee.mobile));
  const [source, setSource] = useState<StaffSource>(attendee.source === "staff_added" ? "staff_added" : "paper_sheet");
  const { run, pending, failure } = useAdminAction();
  const fromDoor = attendee.source === "door_checkin";

  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            updateAttendeeAction({
              attendeeId: attendee.id,
              nameAsWritten: name,
              mobile: mobile.trim() || null,
              source: fromDoor ? undefined : source,
            }),
          onDone,
        );
      }}
    >
      <Field label="Name as written">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} className="h-11 sm:h-9" />
      </Field>
      <Field label="Mobile (optional)">
        <Input type="tel" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} autoComplete="off" maxLength={40} className="h-11 sm:h-9" />
      </Field>
      {fromDoor ? null : <SourcePicker value={source} onChange={setSource} />}
      <ActionNotice failure={failure} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" className={TAP} disabled={pending || !name.trim()}>
          {pending ? "Saving" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" className={TAP} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Matching by hand, for a nickname or a misspelling the name rules miss: search the
// opening's applicants not yet matched on this session.
function LinkPicker({ attendee, choices, onDone }: { attendee: SessionAttendee; choices: LinkChoice[]; onDone: () => void }) {
  const [query, setQuery] = useState(() => attendee.nameAsWritten.split(" ").slice(-1)[0] ?? "");
  const { run, pending, failure } = useAdminAction();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results =
    words.length === 0
      ? []
      : choices.filter((c) => words.every((word) => `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase().includes(word))).slice(0, 6);

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Field label="Search this opening's applicants">
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="h-11 sm:h-9" />
      </Field>
      {words.length > 0 && results.length === 0 ? <p className="text-sm text-muted-foreground">Nobody by that name has applied to this opening.</p> : null}
      <ul className="grid gap-2">
        {results.map((c) => (
          <li key={c.applicationId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{fullName(c.firstName, c.lastName)}</span>{" "}
              <span className="text-muted-foreground">
                started {formatDay(c.startedAt)}
                {c.mobile ? `, ${formatMobile(c.mobile)}` : ""}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              className={TAP}
              disabled={pending}
              onClick={() => run(() => confirmMatchAction({ attendeeId: attendee.id, applicationId: c.applicationId }), onDone)}
            >
              Link
            </Button>
          </li>
        ))}
      </ul>
      <ActionNotice failure={failure} />
      <div>
        <Button type="button" size="sm" variant="ghost" className={TAP} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
