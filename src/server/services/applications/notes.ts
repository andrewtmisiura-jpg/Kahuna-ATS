import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { application, note } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "../actor";
import { writeAudit } from "../audit";

// Staff notes (DATA_MODEL.md, note). Notes are append-only: an edit soft-deletes
// the old row and adds a new one, linked by a note.edit audit row, so there is no
// revision table and the earlier wording is kept. The author or an Admin may edit
// or delete.

export type NoteErrorCode = "note_not_found" | "application_not_found" | "body_required" | "not_allowed";

export class NoteError extends Error {
  constructor(
    readonly code: NoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoteError";
  }
}

export const NOTE_MAX_LENGTH = 4000;

function cleanBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new NoteError("body_required", "Write something first");
  return trimmed.slice(0, NOTE_MAX_LENGTH);
}

export async function addNote(
  db: Db,
  input: { applicationId: string; body: string; isRestricted: boolean; userId: string; now?: Date },
): Promise<{ noteId: string }> {
  const body = cleanBody(input.body);
  const [app] = await db.select({ id: application.id, personId: application.personId, deletedAt: application.deletedAt }).from(application).where(eq(application.id, input.applicationId));
  if (!app || app.deletedAt) throw new NoteError("application_not_found", "No such application");
  const id = uuidv7();
  await db.insert(note).values({
    id,
    personId: app.personId,
    applicationId: app.id,
    body,
    isRestricted: input.isRestricted,
    authorUserId: input.userId,
    createdAt: input.now ?? new Date(),
  });
  return { noteId: id };
}

async function loadEditable(db: Db, noteId: string, userId: string, role: UserRole) {
  const [row] = await db.select().from(note).where(eq(note.id, noteId));
  if (!row || row.deletedAt) throw new NoteError("note_not_found", "No such note");
  if (row.authorUserId !== userId && role !== "admin") throw new NoteError("not_allowed", "Only the author or an Admin can change this note");
  return row;
}

// The new row carries the corrected text; the old row keeps the original under deleted_at.
export async function editNote(
  db: Db,
  input: { noteId: string; body: string; isRestricted: boolean; userId: string; role: UserRole; now?: Date },
): Promise<{ noteId: string; replacedNoteId: string }> {
  const body = cleanBody(input.body);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const old = await loadEditable(tx, input.noteId, input.userId, input.role);
    const id = uuidv7();
    await tx.insert(note).values({
      id,
      personId: old.personId,
      applicationId: old.applicationId,
      body,
      isRestricted: input.isRestricted,
      authorUserId: input.userId,
      createdAt: now,
    });
    await tx.update(note).set({ deletedAt: now }).where(eq(note.id, old.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "note.edit",
      entityType: "note",
      entityId: id,
      personId: old.personId,
      applicationId: old.applicationId,
      changes: { replaces_note_id: old.id, is_restricted: { from: old.isRestricted, to: input.isRestricted } },
      occurredAt: now,
    });
    return { noteId: id, replacedNoteId: old.id };
  });
}

export async function deleteNote(db: Db, input: { noteId: string; userId: string; role: UserRole; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const old = await loadEditable(tx, input.noteId, input.userId, input.role);
    await tx.update(note).set({ deletedAt: now }).where(eq(note.id, old.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "note.delete",
      entityType: "note",
      entityId: old.id,
      personId: old.personId,
      applicationId: old.applicationId,
      occurredAt: now,
    });
  });
}
