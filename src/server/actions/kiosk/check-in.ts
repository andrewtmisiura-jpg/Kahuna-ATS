"use server";

import { z } from "zod";
import { kioskAccess } from "@/app/(kiosk)/_lib/kiosk-access";
import { db } from "@/db";
import { checkIn } from "@/server/services/sessions/attendees";
import { loggableError, SessionError } from "@/server/services/sessions/errors";

// The door check-in (Phase 2, sessions). The tablet holds the kiosk credential a staff
// member started for this session, so the same check as the kiosk page comes first.
// The person at the door sees only their own result, in plain words, and never another
// attendee.

export type CheckInActionResult = { ok: true; firstName: string } | { ok: false; field: "name" | "mobile" | null; message: string };

const ASK_STAFF = "Something went wrong. Please ask a staff member to check you in.";

const checkInSchema = z.object({ sessionId: z.uuid(), name: z.string().max(500), mobile: z.string().max(40) });

export async function checkInAction(raw: z.input<typeof checkInSchema>): Promise<CheckInActionResult> {
  const parsed = checkInSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, field: null, message: ASK_STAFF };
  const staff = await kioskAccess(parsed.data.sessionId);
  if (!staff) return { ok: false, field: null, message: "This tablet is not set up for check-in. Please ask a staff member." };
  try {
    const result = await checkIn(db, { ...parsed.data, staff });
    return { ok: true, firstName: result.firstName };
  } catch (error) {
    if (error instanceof SessionError) {
      if (error.code === "name_required") return { ok: false, field: "name", message: "Enter your name" };
      if (error.code === "name_too_long") return { ok: false, field: "name", message: error.message };
      if (error.code === "invalid_mobile") return { ok: false, field: "mobile", message: error.message };
      if (error.code === "checkin_closed") return { ok: false, field: null, message: error.message };
    }
    console.error(`[check-in action] ${loggableError(error)}`);
    return { ok: false, field: null, message: ASK_STAFF };
  }
}
