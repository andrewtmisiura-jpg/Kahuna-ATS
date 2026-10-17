"use server";

import { z } from "zod";
import { db } from "@/db";
import { STAR_MARKS } from "@/db/schema";
import { requireRole } from "@/server/auth/require-role";
import type { SessionUser } from "@/server/auth/session";
import { addAttendee, removeAttendee, STAFF_SOURCES, updateAttendee } from "@/server/services/sessions/attendees";
import { SESSION_STAFF_ROLES, SessionError, type SessionStaff } from "@/server/services/sessions/errors";
import { confirmMatch, dismissSuggestion, matchSessionByPhone, unmatchAttendee } from "@/server/services/sessions/matching";
import { addMark, removeMark } from "@/server/services/sessions/stars";
import { toActionFailure, type ActionResult } from "./application-errors";

// Group session actions (Phase 2, sessions): typing in the sign-up sheet, matching
// people to their applications, and the stars and concerns from the floor view. Each
// one starts with requireRole, hands the work to a service and returns the same
// ActionResult as the applicant actions, so the client handles it with
// useAdminAction. Viewers never reach them.

function staffOf(user: SessionUser): SessionStaff {
  return { userId: user.id, role: user.role };
}

async function run<T>(fn: (staff: SessionStaff) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(SESSION_STAFF_ROLES);
    return { ok: true, data: await fn(staffOf(user)) };
  } catch (error) {
    if (error instanceof SessionError) {
      return { ok: false, status: error.code.endsWith("_not_found") ? 404 : 400, code: error.code, message: error.message };
    }
    return toActionFailure(error);
  }
}

const uuid = z.uuid();
const name = z.string().max(500);
const mobile = z.string().max(40).nullable().optional();

const addSchema = z.object({ sessionId: uuid, nameAsWritten: name, mobile, source: z.enum(STAFF_SOURCES) });

export async function addAttendeeAction(raw: z.input<typeof addSchema>): Promise<ActionResult<{ attendeeId: string; matched: boolean }>> {
  return run(async (staff) => {
    const input = addSchema.parse(raw);
    const result = await addAttendee(db, { ...input, staff });
    return { attendeeId: result.attendeeId, matched: result.matchedApplicationId !== null };
  });
}

const updateSchema = z.object({ attendeeId: uuid, nameAsWritten: name.optional(), mobile, source: z.enum(STAFF_SOURCES).optional() });

export async function updateAttendeeAction(raw: z.input<typeof updateSchema>): Promise<ActionResult<{ changed: string[]; matched: boolean }>> {
  return run(async (staff) => {
    const input = updateSchema.parse(raw);
    const result = await updateAttendee(db, { ...input, staff });
    return { changed: result.changed, matched: result.matchedApplicationId !== null };
  });
}

const attendeeSchema = z.object({ attendeeId: uuid });

export async function removeAttendeeAction(raw: z.input<typeof attendeeSchema>): Promise<ActionResult<null>> {
  return run(async (staff) => {
    await removeAttendee(db, { ...attendeeSchema.parse(raw), staff });
    return null;
  });
}

const sessionSchema = z.object({ sessionId: uuid });

// The Match now button: every unmatched row with an exact mobile match.
export async function matchNowAction(raw: z.input<typeof sessionSchema>): Promise<ActionResult<{ linked: number }>> {
  return run(async () => matchSessionByPhone(db, sessionSchema.parse(raw).sessionId));
}

const pairSchema = z.object({ attendeeId: uuid, applicationId: uuid });

export async function confirmMatchAction(raw: z.input<typeof pairSchema>): Promise<ActionResult<{ changed: boolean }>> {
  return run(async (staff) => confirmMatch(db, { ...pairSchema.parse(raw), staff }));
}

export async function dismissSuggestionAction(raw: z.input<typeof pairSchema>): Promise<ActionResult<null>> {
  return run(async (staff) => {
    await dismissSuggestion(db, { ...pairSchema.parse(raw), staff });
    return null;
  });
}

export async function unmatchAttendeeAction(raw: z.input<typeof attendeeSchema>): Promise<ActionResult<null>> {
  return run(async (staff) => {
    await unmatchAttendee(db, { ...attendeeSchema.parse(raw), staff });
    return null;
  });
}

const addMarkSchema = z.object({
  attendeeId: uuid,
  mark: z.enum(STAR_MARKS),
  reasonOptionId: uuid.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

export async function addMarkAction(raw: z.input<typeof addMarkSchema>): Promise<ActionResult<{ added: boolean }>> {
  return run(async (staff) => {
    const result = await addMark(db, { ...addMarkSchema.parse(raw), staff });
    return { added: result.added };
  });
}

const removeMarkSchema = z.object({ attendeeId: uuid, mark: z.enum(STAR_MARKS) });

export async function removeMarkAction(raw: z.input<typeof removeMarkSchema>): Promise<ActionResult<{ removed: boolean }>> {
  return run(async (staff) => removeMark(db, { ...removeMarkSchema.parse(raw), staff }));
}
