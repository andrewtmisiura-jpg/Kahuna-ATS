"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { ActionNotice } from "@/components/admin/applicants/fields";
import { useAdminAction } from "@/components/admin/applicants/use-admin-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { StarMark } from "@/db/schema";
import { addMarkAction, removeMarkAction } from "@/server/actions/admin/attendees";
import type { SessionAttendee } from "@/server/services/sessions/queries";
import type { StarReason } from "@/server/services/sessions/stars";
import { formatTime, SOURCE_LABELS } from "./format";
import { MarkCounts, MarkIcon, MarksList } from "./marks";

// The floor view: the session's attendees on a phone, each with a Star and a Concern
// button. Tapping one opens a short form (a reason from the list, a note of up to 140
// characters); tapping a mark you already gave takes it back. A star needs nothing
// more; a concern needs a reason or a note. Everyone's marks show under each name.

const NOTE_MAX = 140;

export function FloorView({ attendees, reasons, userId }: { attendees: SessionAttendee[]; reasons: StarReason[]; userId: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const sorted = useMemo(
    () => [...attendees].sort((a, b) => a.nameAsWritten.localeCompare(b.nameAsWritten, "en", { sensitivity: "base" })),
    [attendees],
  );
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sorted.filter((a) => words.every((word) => a.nameAsWritten.toLowerCase().includes(word)));

  return (
    <div className="grid gap-3">
      <div className="flex gap-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a name"
          aria-label="Find a name"
          autoComplete="off"
          className="h-11"
        />
        <Button type="button" variant="outline" className="h-11" onClick={() => router.refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {attendees.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody is on the list yet. Add people from the sign-up sheet on the session page, or hand a tablet with the door check-in to people as
          they arrive, then tap Refresh.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody on the list matches that name.</p>
      ) : null}
      {shown.map((a) => (
        <FloorCard key={a.id} attendee={a} reasons={reasons} userId={userId} />
      ))}
    </div>
  );
}

function FloorCard({ attendee, reasons, userId }: { attendee: SessionAttendee; reasons: StarReason[]; userId: string }) {
  const [open, setOpen] = useState<StarMark | null>(null);
  const { run, pending, failure } = useAdminAction();
  const mine = {
    star: attendee.marks.find((m) => m.mark === "star" && m.userId === userId) ?? null,
    concern: attendee.marks.find((m) => m.mark === "concern" && m.userId === userId) ?? null,
  };
  const where = SOURCE_LABELS[attendee.source] + (attendee.source === "door_checkin" ? ` at ${formatTime(attendee.createdAt)}` : "");

  function tap(mark: StarMark) {
    if (mine[mark]) {
      setOpen(null);
      run(() => removeMarkAction({ attendeeId: attendee.id, mark }));
    } else {
      setOpen(open === mark ? null : mark);
    }
  }

  return (
    <section aria-label={attendee.nameAsWritten} className="grid gap-3 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-medium break-words">{attendee.nameAsWritten}</h2>
          <p className="text-xs text-muted-foreground">
            {where}
            {attendee.match ? " · Applied" : ""}
          </p>
        </div>
        <MarkCounts marks={attendee.marks} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={mine.star ? "secondary" : "outline"}
          aria-pressed={Boolean(mine.star)}
          title={mine.star ? "Tap to take your star back" : undefined}
          className={cn("h-12", mine.star && "border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100")}
          disabled={pending}
          onClick={() => tap("star")}
        >
          <MarkIcon mark="star" filled={Boolean(mine.star)} />
          {mine.star ? "Starred" : "Star"}
        </Button>
        <Button
          type="button"
          variant={mine.concern ? "secondary" : "outline"}
          aria-pressed={Boolean(mine.concern)}
          title={mine.concern ? "Tap to take your concern back" : undefined}
          className={cn("h-12", mine.concern && "border border-red-300 bg-red-50 text-red-900 hover:bg-red-100")}
          disabled={pending}
          onClick={() => tap("concern")}
        >
          <MarkIcon mark="concern" />
          {mine.concern ? "Concern noted" : "Concern"}
        </Button>
      </div>
      {open ? (
        <MarkForm
          key={open}
          mark={open}
          name={attendee.nameAsWritten}
          reasons={reasons}
          pending={pending}
          onCancel={() => setOpen(null)}
          onSave={(mark, reasonOptionId, note) =>
            run(
              () => addMarkAction({ attendeeId: attendee.id, mark, reasonOptionId, note }),
              () => setOpen(null),
            )
          }
        />
      ) : null}
      <MarksList marks={attendee.marks} />
      <ActionNotice failure={failure} />
    </section>
  );
}

function MarkForm({
  mark,
  name,
  reasons,
  pending,
  onSave,
  onCancel,
}: {
  mark: StarMark;
  name: string;
  reasons: StarReason[];
  pending: boolean;
  onSave: (mark: StarMark, reasonOptionId: string | null, note: string | null) => void;
  onCancel: () => void;
}) {
  const noteId = useId();
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const reason = reasons.find((r) => r.id === reasonId) ?? null;
  const hasNote = note.trim().length > 0;
  const canSave = (!reason?.requiresNote || hasNote) && (mark === "star" || Boolean(reasonId) || hasNote);

  return (
    <form
      className="grid gap-3 rounded-md bg-muted/40 p-3"
      aria-label={mark === "star" ? `Star for ${name}` : `Concern about ${name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave(mark, reasonId, note.trim() || null);
      }}
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium">{mark === "star" ? "Reason (optional)" : "Reason"}</p>
        <div role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-2">
          {reasons.map((r) => {
            const picked = r.id === reasonId;
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={picked}
                onClick={() => setReasonId(picked ? null : r.id)}
                className={cn(
                  "min-h-11 rounded-full border px-4 text-sm",
                  picked ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium">
          Note (optional)
        </label>
        <Input
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          autoComplete="off"
          className="h-11"
        />
        <p className="text-xs text-muted-foreground">
          {note.length}/{NOTE_MAX}. Facts only: nothing about health, age, family or anything else off the do-not-ask list.
        </p>
      </div>
      {mark === "concern" ? <p className="text-xs text-muted-foreground">A concern needs a reason or a note.</p> : null}
      {reason?.requiresNote && !hasNote ? <p className="text-xs text-muted-foreground">Add a note for &ldquo;{reason.label}&rdquo;.</p> : null}
      <div className="flex gap-2">
        <Button type="submit" className="h-11 flex-1" disabled={pending || !canSave}>
          {mark === "star" ? "Give star" : "Add concern"}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
