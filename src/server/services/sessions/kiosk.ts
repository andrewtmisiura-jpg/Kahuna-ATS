import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@/db";
import { staffActor } from "../actor";
import { writeAudit } from "../audit";
import { addDays, centralDate, startOfCentralDay } from "../time";
import { findUserById } from "../users";
import { checkInClosedMessage, checkInState } from "./attendees";
import { assertCanAct, SESSION_STAFF_ROLES, SessionError, type SessionStaff } from "./errors";
import { getSessionSummary } from "./queries";

// The door check-in's own credential (Phase 2, sessions). A staff member starts the
// kiosk on the tablet from the session page; the tablet gets a signed token for that one
// session's check-in, in a cookie sent only to its /check-in page and good until the end
// of the session's day (Central), and the staff member is then signed out on it. The
// kiosk page and the check-in action accept this token and nothing else, so nobody at
// the door can reach the rest of the app, by Back or by typing an address.

export const KIOSK_COOKIE = "kahuna_check_in";

export type KioskGrant = { sessionId: string; userId: string; expiresAt: Date };

export function kioskPath(sessionId: string): string {
  return `/check-in/${sessionId}`;
}

// Tokens are signed with a key of their own, derived from BETTER_AUTH_SECRET.
function sign(payload: string, secret: string): string {
  const key = createHmac("sha256", secret).update("door check-in").digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintKioskToken(grant: KioskGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ s: grant.sessionId, u: grant.userId, e: grant.expiresAt.getTime() })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

// The grant a token carries, or null when it is malformed, signed with another key or expired.
export function readKioskToken(token: string, secret: string, now: Date): KioskGrant | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; u?: unknown; e?: unknown };
    if (typeof parsed.s !== "string" || typeof parsed.u !== "string" || typeof parsed.e !== "number" || parsed.e <= now.getTime()) return null;
    return { sessionId: parsed.s, userId: parsed.u, expiresAt: new Date(parsed.e) };
  } catch {
    return null;
  }
}

// Starting the kiosk: only on the session's day while check-in is open, and audited, so
// the session's history shows who set up a tablet and until when.
export async function startKiosk(db: Db, input: { sessionId: string; staff: SessionStaff; now?: Date }): Promise<KioskGrant> {
  assertCanAct(input.staff);
  const now = input.now ?? new Date();
  const session = await getSessionSummary(db, input.sessionId);
  if (!session) throw new SessionError("session_not_found", "No such session");
  const state = checkInState(session, now);
  if (!state.open) throw new SessionError("checkin_closed", checkInClosedMessage(state.reason));
  const grant = { sessionId: session.id, userId: input.staff.userId, expiresAt: startOfCentralDay(addDays(centralDate(session.startsAt), 1)) };
  await writeAudit(db, {
    actor: staffActor(input.staff.userId),
    action: "group_session.kiosk_start",
    entityType: "group_session",
    entityId: session.id,
    changes: { expires_at: grant.expiresAt.toISOString() },
    occurredAt: now,
  });
  return grant;
}

// The staff member behind a kiosk token for this session, when they are still an active
// Admin or Hiring Manager (disabling them stops their kiosk too), or null.
export async function kioskStaff(
  db: Db,
  input: { token: string | undefined; sessionId: string; secret: string | undefined; now?: Date },
): Promise<SessionStaff | null> {
  if (!input.token || !input.secret) return null;
  const grant = readKioskToken(input.token, input.secret, input.now ?? new Date());
  if (!grant || grant.sessionId !== input.sessionId) return null;
  const user = await findUserById(db, grant.userId);
  if (!user || user.status !== "active" || !SESSION_STAFF_ROLES.includes(user.role)) return null;
  return { userId: user.id, role: user.role };
}
