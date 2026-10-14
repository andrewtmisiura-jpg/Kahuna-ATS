"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addApplicationNote, deleteApplicationNote, editApplicationNote } from "@/server/actions/admin/applications";
import type { SessionUser } from "@/server/auth/session";
import type { ProfileNote } from "@/server/services/applications/queries";
import { ActionNotice, CheckboxRow, Textarea } from "./fields";
import { formatDateTime } from "./format";
import { Empty, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// Notes: add with the restricted flag; an edit writes a new note row linked to
// the old one; the author or an Admin can edit or delete.

export function NotesSection({ notes, applicationId, user }: { notes: ProfileNote[]; applicationId: string; user: SessionUser }) {
  const canAct = user.role !== "viewer";
  const [body, setBody] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string; restricted: boolean } | null>(null);
  const { run, pending, failure } = useAdminAction();

  function add(e: React.FormEvent) {
    e.preventDefault();
    run(
      () => addApplicationNote({ applicationId, body, isRestricted: restricted }),
      () => {
        setBody("");
        setRestricted(false);
      },
    );
  }

  function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    run(
      () => editApplicationNote({ noteId: editing.id, body: editing.body, isRestricted: editing.restricted }),
      () => setEditing(null),
    );
  }

  return (
    <Section title="Notes">
      <div className="grid gap-3">
        {notes.length === 0 ? <Empty>No notes yet.</Empty> : null}
        {notes.map((note) => {
          const mine = note.authorId === user.id;
          const isEditing = editing?.id === note.id;
          return (
            <div key={note.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{note.authorName}</span>
                <span>{formatDateTime(note.createdAt)}</span>
                {note.isRestricted ? <Badge variant="outline">Restricted</Badge> : null}
                {note.replacesNoteId ? <span>(edited)</span> : null}
              </div>
              {isEditing ? (
                <form onSubmit={saveEdit} className="mt-2 grid gap-2">
                  <Textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} maxLength={4000} />
                  <CheckboxRow label="Restricted" checked={editing.restricted} onChange={(v) => setEditing({ ...editing, restricted: v })} />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={pending}>
                      Save as a new note
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="mt-1 whitespace-pre-wrap">{note.body}</p>
              )}
              {note.replacedBody ? (
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Earlier wording</summary>
                  <p className="mt-1 whitespace-pre-wrap">{note.replacedBody}</p>
                </details>
              ) : null}
              {canAct && (mine || user.role === "admin") && !isEditing ? (
                <div className="mt-2 flex gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setEditing({ id: note.id, body: note.body ?? "", restricted: note.isRestricted })}>
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm("Delete this note? The text is kept in the record but no longer shown.")) run(() => deleteApplicationNote({ noteId: note.id }));
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}

        {canAct ? (
          <form onSubmit={add} className="grid gap-2">
            <Textarea placeholder="Write facts. No health, disability, age, family or anything else off the do-not-ask list." value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
            <CheckboxRow
              label="Restricted (accommodation or health information)"
              hint="Only Admins and Hiring Managers see restricted notes. They are never exported."
              checked={restricted}
              onChange={setRestricted}
            />
            <div>
              <Button type="submit" size="sm" disabled={pending || !body.trim()}>
                Add note
              </Button>
            </div>
          </form>
        ) : null}
        <ActionNotice failure={failure} />
      </div>
    </Section>
  );
}
