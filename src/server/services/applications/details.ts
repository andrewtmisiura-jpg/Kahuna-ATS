import { eq } from "drizzle-orm";
import { sourceTakesDetail } from "@/components/applicant/sources";
import type { Db } from "@/db";
import { application, GROUP_INTERVIEW_ARRIVALS, groupSession, sourceEnum, type GroupInterviewArrival } from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "../actor";
import { diffChanges, writeAudit } from "../audit";

// Staff edits to an application's details on the profile (DATA_MODEL.md,
// application): how they heard about us (source and its detail), the group
// session the application is attributed to and how they arrived at the group
// interview. All are audited; the detail is PII text, so its values are recorded
// as "[changed]".

export type DetailErrorCode =
  | "application_not_found"
  | "invalid_source"
  | "detail_too_long"
  | "session_not_found"
  | "session_wrong_opening"
  | "session_canceled"
  | "invalid_arrival"
  | "arrival_not_allowed";

export class DetailError extends Error {
  constructor(
    readonly code: DetailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DetailError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ApplicationRow = typeof application.$inferSelect;
export type Source = NonNullable<ApplicationRow["source"]>;

export const SOURCE_DETAIL_MAX = 200;

async function lockApplication(tx: Tx, applicationId: string): Promise<ApplicationRow> {
  const [row] = await tx.select().from(application).where(eq(application.id, applicationId)).for("update");
  if (!row || row.deletedAt) throw new DetailError("application_not_found", "No such application");
  return row;
}

export type UpdateSourceInput = {
  applicationId: string;
  userId: string;
  // Null clears it ("not given").
  source: Source | null;
  sourceDetail?: string | null;
  now?: Date;
};

// The detail is kept only for the sources that ask for it (a referrer's name, the
// "other" text), the same rule as the landing form. A current employee is left
// out of analysis from the moment the source says so; moving the source away from
// current employee puts the application back in, since that was the only reason.
export async function updateSource(db: Db, input: UpdateSourceInput): Promise<{ changed: string[] }> {
  const source = input.source;
  if (source !== null && !(sourceEnum.enumValues as readonly string[]).includes(source)) {
    throw new DetailError("invalid_source", "Pick how they heard about us from the list");
  }
  const detail = sourceTakesDetail(source) ? input.sourceDetail?.trim() || null : null;
  if (detail && detail.length > SOURCE_DETAIL_MAX) throw new DetailError("detail_too_long", `Keep the detail under ${SOURCE_DETAIL_MAX} characters`);
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const before = await lockApplication(tx, input.applicationId);
    const excludeFromAnalysis = source === "current_employee" ? true : before.source === "current_employee" ? false : before.excludeFromAnalysis;
    const after = { ...before, source, sourceDetail: detail, excludeFromAnalysis };
    const changes = diffChanges(before, after, ["source", "sourceDetail", "excludeFromAnalysis"], ["sourceDetail"]);
    if (Object.keys(changes).length === 0) return { changed: [] };
    await tx
      .update(application)
      .set({ source, sourceDetail: detail, sourceSetBy: source ? "staff" : null, excludeFromAnalysis, updatedAt: now })
      .where(eq(application.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "application.source_change",
      entityType: "application",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.id,
      changes,
      occurredAt: now,
    });
    return { changed: Object.keys(changes) };
  });
}

export type SetSessionInput = {
  applicationId: string;
  userId: string;
  // Null clears the attribution.
  sessionId: string | null;
  now?: Date;
};

// Sets or clears the attributed group session, for someone who scanned the role
// QR at a session instead of the session's own code. The session must belong to
// the application's opening, and must not be canceled or deleted. Picking the
// session the application scanned restores that attribution; any other pick is
// staff confirmed. Saving the session already attributed changes nothing, so its
// method (scanned, matched by phone) is kept.
export async function setAttributedSession(db: Db, input: SetSessionInput): Promise<{ changed: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const before = await lockApplication(tx, input.applicationId);
    const sessionId = input.sessionId ?? null;
    if (sessionId === before.attributedSessionId) return { changed: false };
    if (sessionId) {
      const [session] = await tx.select().from(groupSession).where(eq(groupSession.id, sessionId));
      if (!session || session.deletedAt) throw new DetailError("session_not_found", "No such group session");
      if (session.openingId !== before.openingId) {
        throw new DetailError("session_wrong_opening", "That session belongs to another opening");
      }
      if (session.status === "canceled") throw new DetailError("session_canceled", "That session was canceled");
    }
    const attributionMethod: ApplicationRow["attributionMethod"] =
      sessionId === null ? "none" : sessionId === before.scannedSessionId ? "scanned_session" : "staff_confirmed";

    await tx.update(application).set({ attributedSessionId: sessionId, attributionMethod, updatedAt: now }).where(eq(application.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "application.session_attribution",
      entityType: "application",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.id,
      changes: diffChanges(
        { attributedSessionId: before.attributedSessionId, attributionMethod: before.attributionMethod },
        { attributedSessionId: sessionId, attributionMethod },
        ["attributedSessionId", "attributionMethod"],
      ),
      occurredAt: now,
    });
    return { changed: true };
  });
}

export type SetArrivalInput = {
  applicationId: string;
  userId: string;
  // Checked here as well as in the action: Viewers only read arrival.
  role: UserRole;
  // Null clears it ("Not recorded").
  arrival: GroupInterviewArrival | null;
  now?: Date;
};

// Records whether the person showed up on time to the group interview, from the
// profile or the session page. Every change, including clearing it, is audited.
export async function setGroupInterviewArrival(db: Db, input: SetArrivalInput): Promise<{ changed: boolean }> {
  if (input.role !== "admin" && input.role !== "hiring_manager") {
    throw new DetailError("arrival_not_allowed", "Only Admins and Hiring Managers can record arrival");
  }
  const arrival = input.arrival ?? null;
  if (arrival !== null && !(GROUP_INTERVIEW_ARRIVALS as readonly string[]).includes(arrival)) {
    throw new DetailError("invalid_arrival", "Pick on time, late, did not attend or not recorded");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const before = await lockApplication(tx, input.applicationId);
    if (before.groupInterviewArrival === arrival) return { changed: false };
    await tx.update(application).set({ groupInterviewArrival: arrival, updatedAt: now }).where(eq(application.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "application.arrival_change",
      entityType: "application",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.id,
      changes: { groupInterviewArrival: { from: before.groupInterviewArrival, to: arrival } },
      occurredAt: now,
    });
    return { changed: true };
  });
}
