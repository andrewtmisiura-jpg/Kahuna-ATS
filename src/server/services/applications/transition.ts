import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  application,
  applicationEvent,
  appUser,
  backgroundCheck,
  formVersion,
  groupSession,
  hireStint,
  MILESTONES,
  offer,
  opening,
  picklistOption,
  pipelineStage,
  role,
  type ApplicationEventMetadata,
  type Milestone,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { actorColumns, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { addWeekdays, centralDate } from "../time";
import {
  effectiveEvents,
  latestStateChange,
  NEVER_VOIDED_KINDS,
  replayEvents,
  STATE_CHANGING_KINDS,
  voidedEventIds,
  type ApplicationStatus,
  type ClosedOutcome,
  type EventRow,
} from "./replay";

// The one function that writes application_event and keeps the application's
// cached columns in sync (DATA_MODEL.md, "Transitions, replay and voiding").
// Everything runs under `select ... for update` on the application row.

export type ApplicationRow = typeof application.$inferSelect;
type StageRow = typeof pipelineStage.$inferSelect;
type ReasonRow = typeof picklistOption.$inferSelect;
type EventInsert = typeof applicationEvent.$inferInsert;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Background-based disqualification waits this many weekdays after the pre-adverse notice.
export const FCRA_WAIT_WEEKDAYS = 5;

// Staff may enter a time this far ahead of the server clock (browser skew); the
// database check allows the same margin against recorded_at.
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export type TransitionErrorCode =
  | "application_not_found"
  | "stale_version"
  | "stage_not_found"
  | "stage_wrong_role"
  | "stage_archived"
  | "same_stage"
  | "stage_not_allowed"
  | "stage_required"
  | "application_closed"
  | "application_not_closed"
  | "application_hired"
  | "application_not_hired"
  | "application_not_open"
  | "already_submitted"
  | "already_on_hold"
  | "not_on_hold"
  | "occurred_in_future"
  | "occurred_before_previous"
  | "staff_actor_required"
  | "reason_not_found"
  | "reason_wrong_list"
  | "reason_wrong_role"
  | "reason_archived"
  | "note_required"
  | "offer_required"
  | "check_type_required"
  | "fcra_check_required"
  | "fcra_check_not_found"
  | "fcra_pre_adverse_required"
  | "fcra_waiting_period"
  | "fcra_statement_required"
  | "event_not_found"
  | "event_not_voidable"
  | "event_already_voided"
  | "event_not_latest"
  | "opening_not_open"
  | "form_not_published"
  | "session_wrong_opening";

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

// Someone else changed the application first. The UI shows who and reloads.
export class StaleVersionError extends TransitionError {
  constructor(
    readonly expectedSeq: number,
    readonly currentSeq: number,
    readonly changedBy: { userId: string; name: string | null; email: string } | null,
    readonly changedAt: Date,
  ) {
    const who = changedBy ? (changedBy.name ?? changedBy.email) : "the applicant or the system";
    super("stale_version", `Changed by ${who} at ${changedAt.toISOString()}, reload`);
    this.name = "StaleVersionError";
  }
}

type BaseInput = {
  applicationId: string;
  actor: Actor;
  // The event_seq the UI last saw; omitted for applicant and system flows.
  expectedSeq?: number;
  // When it happened; defaults to now. Staff may backdate.
  occurredAt?: Date;
  note?: string | null;
  batchId?: string | null;
  now?: Date;
};

export type OfferInput = {
  isConditional?: boolean;
  plannedStartOn?: string | null;
  payAmount?: string | null;
  payUnit?: "hourly" | "daily" | "salary" | null;
  note?: string | null;
};

export type CheckInput = {
  checkType: "criminal" | "driving_record" | "drug_screen" | "other";
  vendor?: string | null;
  requestedOn?: string | null;
};

export type HireInput = {
  isTemporary?: boolean;
  plannedEndOn?: string | null;
  crewOptionId?: string | null;
  plannedStartOn?: string | null;
  startOn?: string | null;
};

export type FcraInput = {
  // The checks a background-based disqualification relies on.
  backgroundCheckIds?: string[];
  // The recorded statement that a decision made while a check is open does not rely on the report.
  notReportBased?: boolean;
};

export type CloseInput = { outcome: ClosedOutcome; reasonOptionId: string; fcra?: FcraInput };

export type TransitionInput = BaseInput &
  (
    | { action: "move"; toStageId: string; offer?: OfferInput; check?: CheckInput; hire?: HireInput }
    | ({ action: "close" } & CloseInput)
    | { action: "hold" }
    | { action: "unhold" }
    | { action: "reopen"; toStageId?: string }
    | { action: "contacted" }
    // metadata carries the submission snapshot (answers as submitted) written by the answers service.
    | { action: "submit"; metadata?: ApplicationEventMetadata | null }
    | { action: "void"; eventId: string }
    | {
        action: "rescind_hire";
        voidReason: string;
        // Back to open needs the stage to go back to (the service refuses it without one);
        // the field stays optional here so a request missing it fails with stage_required.
        to: { status: "open"; toStageId?: string } | ({ status: "closed" } & CloseInput);
      }
  );

export type TransitionResult = {
  event: EventRow;
  application: ApplicationRow;
  created: { offerId?: string; backgroundCheckId?: string; hireStintId?: string };
};

export async function transition(db: Db, input: TransitionInput): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const now = input.now ?? new Date();
    const app = await lockApplication(tx, input.applicationId);
    if (input.expectedSeq !== undefined && input.expectedSeq !== app.eventSeq) {
      throw await staleVersion(tx, app, input.expectedSeq);
    }

    const events = await loadEvents(tx, app.id);
    const currentStage = await loadStage(tx, app, app.currentStageId);
    const occurredAt = input.action === "void" ? now : resolveOccurredAt(events, input.occurredAt, now);
    const created: TransitionResult["created"] = {};

    const plan = await planEvent(tx, app, currentStage, events, input, occurredAt, now, created);

    const [event] = await tx
      .insert(applicationEvent)
      .values({
        id: uuidv7(),
        applicationId: app.id,
        seq: app.eventSeq + 1,
        ...actorColumns(input.actor),
        occurredAt,
        note: input.note ?? null,
        batchId: input.batchId ?? null,
        ...plan,
      })
      .returning();

    const state = replayEvents([...events, event!]);
    const [updated] = await tx
      .update(application)
      .set({ ...state, lastActivityAt: now })
      .where(eq(application.id, app.id))
      .returning();

    return { event: event!, application: updated!, created };
  });
}

async function planEvent(
  tx: Tx,
  app: ApplicationRow,
  currentStage: StageRow,
  events: EventRow[],
  input: TransitionInput,
  occurredAt: Date,
  now: Date,
  created: TransitionResult["created"],
): Promise<Partial<EventInsert> & { kind: EventInsert["kind"] }> {
  switch (input.action) {
    case "move":
      return planMove(tx, app, currentStage, input, occurredAt, now, created);
    case "close": {
      if (app.status === "closed") throw new TransitionError("application_closed", "The application is already closed");
      if (app.status === "hired") {
        throw new TransitionError("application_hired", "A hired application is rescinded, not closed");
      }
      const reason = await loadReason(tx, app, input.outcome, input.reasonOptionId, input.note);
      const metadata = await fcraMetadata(tx, app, reason, input.outcome, occurredAt, input.fcra, input.actor);
      return {
        kind: "closed",
        fromStatus: app.status,
        toStatus: "closed",
        closedOutcome: input.outcome,
        reasonOptionId: reason.id,
        metadata,
      };
    }
    case "hold":
    case "unhold": {
      if (app.status !== "open") throw new TransitionError("application_not_open", "Only an open application can be held");
      if (input.action === "hold" && app.onHold) throw new TransitionError("already_on_hold", "Already on hold");
      if (input.action === "unhold" && !app.onHold) throw new TransitionError("not_on_hold", "Not on hold");
      return { kind: input.action === "hold" ? "hold_set" : "hold_cleared" };
    }
    case "reopen": {
      if (app.status !== "closed") throw new TransitionError("application_not_closed", "Only a closed application can be reopened");
      const toStage = input.toStageId ? await loadStage(tx, app, input.toStageId) : currentStage;
      if (toStage.milestone === "hired") {
        throw new TransitionError("stage_not_allowed", "Reopen to a stage before Hired, then move to Hired");
      }
      return { kind: "reopened", fromStatus: "closed", toStatus: "open", fromStageId: currentStage.id, toStageId: toStage.id };
    }
    case "contacted":
      return { kind: "contacted" };
    case "submit": {
      if (app.status === "closed") throw new TransitionError("application_closed", "The application is closed");
      if (app.submittedAt) throw new TransitionError("already_submitted", "The application was already submitted");
      const beforeSubmitted = milestoneIndex(currentStage.milestone) < milestoneIndex("submitted");
      const toStage = beforeSubmitted ? await systemStage(tx, app.roleId, "submitted") : currentStage;
      return { kind: "submitted", fromStageId: currentStage.id, toStageId: toStage.id, metadata: input.metadata ?? null };
    }
    case "void":
      return planVoid(tx, events, input.eventId, now);
    case "rescind_hire":
      return planRescind(tx, app, currentStage, input, occurredAt, now);
  }
}

async function planMove(
  tx: Tx,
  app: ApplicationRow,
  currentStage: StageRow,
  input: Extract<TransitionInput, { action: "move" }>,
  occurredAt: Date,
  now: Date,
  created: TransitionResult["created"],
): Promise<Partial<EventInsert> & { kind: "stage_changed" }> {
  if (app.status === "closed") throw new TransitionError("application_closed", "Reopen the application before moving it");
  const toStage = await loadStage(tx, app, input.toStageId);
  if (toStage.id === currentStage.id) throw new TransitionError("same_stage", "The application is already in that stage");

  const from = currentStage.milestone;
  const to = toStage.milestone;
  const entering = (m: Milestone) => to === m && from !== m;
  const metadata: ApplicationEventMetadata = {};
  let toStatus: ApplicationStatus | null = null;

  if (entering("offered")) {
    const actor = requireStaff(input.actor);
    if (!(await liveOffer(tx, app.id))) {
      const id = uuidv7();
      await tx.insert(offer).values({
        id,
        applicationId: app.id,
        offeredOn: centralDate(occurredAt),
        offeredBy: actor.userId,
        isConditional: input.offer?.isConditional ?? true,
        payAmount: input.offer?.payAmount ?? null,
        payUnit: input.offer?.payUnit ?? null,
        plannedStartOn: input.offer?.plannedStartOn ?? null,
        note: input.offer?.note ?? null,
      });
      metadata.offer_id = id;
      created.offerId = id;
    }
  }

  if (entering("background_check")) {
    const live = await liveOffer(tx, app.id);
    if (!live) throw new TransitionError("offer_required", "A background check needs a conditional offer first");
    if (!input.check?.checkType) throw new TransitionError("check_type_required", "Pick the type of check");
    const id = uuidv7();
    await tx.insert(backgroundCheck).values({
      id,
      applicationId: app.id,
      offerId: live.id,
      checkType: input.check.checkType,
      vendor: input.check.vendor ?? null,
      status: "requested",
      requestedOn: input.check.requestedOn ?? centralDate(occurredAt),
    });
    metadata.background_check_id = id;
    created.backgroundCheckId = id;
  }

  if (entering("hired")) {
    toStatus = "hired";
    if (!(await activeStint(tx, app.id))) {
      const id = await createStint(tx, app, input.hire ?? {}, now);
      metadata.hire_stint_id = id;
      created.hireStintId = id;
    }
  } else if (from === "hired" && to !== "hired") {
    // A normal move out of Hired undoes the hire as a mistake.
    toStatus = "open";
    const stint = await activeStint(tx, app.id);
    if (stint) {
      await voidStint(tx, stint.id, "entered_in_error", null, now);
      metadata.voided_hire_stint_id = stint.id;
    }
  }

  return {
    kind: "stage_changed",
    fromStageId: currentStage.id,
    toStageId: toStage.id,
    fromStatus: toStatus ? app.status : null,
    toStatus,
    metadata: Object.keys(metadata).length ? metadata : null,
  };
}

async function planVoid(tx: Tx, events: EventRow[], eventId: string, now: Date) {
  const target = events.find((event) => event.id === eventId);
  if (!target) throw new TransitionError("event_not_found", "No such event on this application");
  if (NEVER_VOIDED_KINDS.includes(target.kind)) {
    throw new TransitionError("event_not_voidable", `A ${target.kind} event cannot be voided`);
  }
  if (voidedEventIds(events).has(target.id)) throw new TransitionError("event_already_voided", "Already voided");
  if (STATE_CHANGING_KINDS.includes(target.kind)) {
    if (latestStateChange(events)?.id !== target.id) {
      throw new TransitionError("event_not_latest", "Only the latest change can be voided; void the later ones first");
    }
  }

  const m = target.metadata ?? {};
  if (m.offer_id) await tx.update(offer).set({ deletedAt: now }).where(eq(offer.id, m.offer_id));
  if (m.background_check_id) {
    await tx.update(backgroundCheck).set({ status: "canceled" }).where(eq(backgroundCheck.id, m.background_check_id));
  }
  if (m.hire_stint_id) await voidStint(tx, m.hire_stint_id, "entered_in_error", null, now);
  // Voiding a move out of Hired, or a rescission, brings the stint back.
  if (m.voided_hire_stint_id) await restoreStint(tx, m.voided_hire_stint_id);
  if (m.rescinded_hire_stint_id) await restoreStint(tx, m.rescinded_hire_stint_id);

  return { kind: "event_voided" as const, voidsEventId: target.id };
}

async function planRescind(
  tx: Tx,
  app: ApplicationRow,
  currentStage: StageRow,
  input: Extract<TransitionInput, { action: "rescind_hire" }>,
  occurredAt: Date,
  now: Date,
): Promise<Partial<EventInsert> & { kind: "hire_rescinded" }> {
  if (app.status !== "hired") throw new TransitionError("application_not_hired", "Only a hired application can be rescinded");
  if (!input.voidReason.trim()) throw new TransitionError("note_required", "Say why the hire is rescinded");

  // Check where the application goes before touching the stint. An open
  // application cannot stay in the Hired stage, so going back to open names the stage.
  let plan: Partial<EventInsert> & { kind: "hire_rescinded" };
  if (input.to.status === "open") {
    if (!input.to.toStageId) throw new TransitionError("stage_required", "Pick the stage the application goes back to");
    const toStage = await loadStage(tx, app, input.to.toStageId);
    if (toStage.milestone === "hired") throw new TransitionError("stage_not_allowed", "Pick a stage before Hired");
    plan = { kind: "hire_rescinded", fromStatus: "hired", toStatus: "open", fromStageId: currentStage.id, toStageId: toStage.id };
  } else {
    const reason = await loadReason(tx, app, input.to.outcome, input.to.reasonOptionId, input.note);
    const fcra = await fcraMetadata(tx, app, reason, input.to.outcome, occurredAt, input.to.fcra, input.actor);
    plan = { kind: "hire_rescinded", fromStatus: "hired", toStatus: "closed", closedOutcome: input.to.outcome, reasonOptionId: reason.id, metadata: fcra };
  }

  const metadata: ApplicationEventMetadata = { ...(plan.metadata ?? {}) };
  const stint = await activeStint(tx, app.id);
  if (stint) {
    await voidStint(tx, stint.id, "rescinded", input.voidReason.trim(), now);
    metadata.rescinded_hire_stint_id = stint.id;
  }
  return { ...plan, metadata: Object.keys(metadata).length ? metadata : null };
}

// The FCRA gate (PLAN.md, Decisions; DATA_MODEL.md, Key invariants). A
// background-based reason needs the checks it relies on, each past its waiting
// period; any other disqualification or not-selected closure while a check is open
// needs the recorded statement that it does not rely on the report.
async function fcraMetadata(
  tx: Tx,
  app: ApplicationRow,
  reason: ReasonRow,
  outcome: ClosedOutcome,
  occurredAt: Date,
  fcra: FcraInput | undefined,
  actor: Actor,
): Promise<ApplicationEventMetadata | null> {
  const checks = await tx.select().from(backgroundCheck).where(eq(backgroundCheck.applicationId, app.id));

  if (reason.fcraAdverse) {
    const ids = fcra?.backgroundCheckIds ?? [];
    if (ids.length === 0) {
      throw new TransitionError("fcra_check_required", "Name the background check this decision relies on");
    }
    const day = centralDate(occurredAt);
    for (const id of ids) {
      const check = checks.find((c) => c.id === id);
      if (!check) throw new TransitionError("fcra_check_not_found", "That check is not on this application");
      if (!check.preAdverseNoticeOn) {
        throw new TransitionError("fcra_pre_adverse_required", "Record the pre-adverse notice date on the check first");
      }
      const earliest = addWeekdays(check.preAdverseNoticeOn, FCRA_WAIT_WEEKDAYS);
      if (day < earliest) {
        throw new TransitionError(
          "fcra_waiting_period",
          `The pre-adverse notice went out ${check.preAdverseNoticeOn}; this decision can be recorded from ${earliest}`,
          { earliest, checkId: id },
        );
      }
    }
    return { background_check_ids: ids };
  }

  const open = checks.filter(isOpenCheck);
  if (outcome !== "withdrew" && open.length > 0) {
    if (!fcra?.notReportBased) {
      throw new TransitionError(
        "fcra_statement_required",
        "A background check is open: confirm this decision does not rely on the report, or use a background-based reason",
        { openCheckIds: open.map((c) => c.id) },
      );
    }
    await writeAudit(tx, {
      actor,
      action: "application.close_not_report_based",
      entityType: "application",
      entityId: app.id,
      applicationId: app.id,
      personId: app.personId,
      changes: { open_background_check_ids: open.map((c) => c.id), outcome, reason_key: reason.key },
      occurredAt,
    });
    return { not_report_based: true };
  }
  return null;
}

export function isOpenCheck(check: { status: typeof backgroundCheck.$inferSelect.status }) {
  return ["requested", "in_progress", "needs_review", "pre_adverse_sent"].includes(check.status);
}

const LIST_FOR_OUTCOME = {
  disqualified: "disqualify_reason",
  withdrew: "withdraw_reason",
  not_selected: "not_selected_reason",
} as const;

async function loadReason(tx: Tx, app: ApplicationRow, outcome: ClosedOutcome, reasonOptionId: string, note: string | null | undefined) {
  const [option] = await tx.select().from(picklistOption).where(eq(picklistOption.id, reasonOptionId));
  if (!option) throw new TransitionError("reason_not_found", "Pick a reason");
  if (option.listKey !== LIST_FOR_OUTCOME[outcome]) {
    throw new TransitionError("reason_wrong_list", `The reason must come from the ${LIST_FOR_OUTCOME[outcome]} list`);
  }
  if (option.archivedAt) throw new TransitionError("reason_archived", "That reason is archived");
  const [appRole] = await tx.select({ employerId: role.employerId }).from(role).where(eq(role.id, app.roleId));
  if ((option.roleId && option.roleId !== app.roleId) || (option.employerId && option.employerId !== appRole?.employerId)) {
    throw new TransitionError("reason_wrong_role", "That reason belongs to another role");
  }
  if (option.requiresNote && !note?.trim()) throw new TransitionError("note_required", "This reason needs a note");
  return option;
}

async function lockApplication(tx: Tx, id: string): Promise<ApplicationRow> {
  const [row] = await tx.select().from(application).where(eq(application.id, id)).for("update");
  if (!row || row.deletedAt) throw new TransitionError("application_not_found", "No such application");
  return row;
}

async function loadEvents(tx: Tx, applicationId: string): Promise<EventRow[]> {
  return tx
    .select()
    .from(applicationEvent)
    .where(eq(applicationEvent.applicationId, applicationId))
    .orderBy(asc(applicationEvent.seq));
}

// A target stage must belong to the application's role and not be archived.
async function loadStage(tx: Tx, app: ApplicationRow, stageId: string): Promise<StageRow> {
  const [stage] = await tx.select().from(pipelineStage).where(eq(pipelineStage.id, stageId));
  if (!stage) throw new TransitionError("stage_not_found", "No such stage");
  if (stage.roleId !== app.roleId) throw new TransitionError("stage_wrong_role", "That stage belongs to another role");
  if (stage.archivedAt && stage.id !== app.currentStageId) {
    throw new TransitionError("stage_archived", "That stage is archived");
  }
  return stage;
}

async function systemStage(tx: Tx, roleId: string, milestone: "started" | "submitted"): Promise<StageRow> {
  const [stage] = await tx
    .select()
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.roleId, roleId),
        eq(pipelineStage.milestone, milestone),
        eq(pipelineStage.isSystem, true),
        isNull(pipelineStage.archivedAt),
      ),
    )
    .orderBy(asc(pipelineStage.sortOrder))
    .limit(1);
  if (!stage) throw new TransitionError("stage_not_found", `The role has no ${milestone} stage`);
  return stage;
}

export function milestoneIndex(milestone: Milestone | null): number {
  return milestone ? MILESTONES.indexOf(milestone) : -1;
}

// Not in the future, and not before the previous event that still counts, so a
// voided mistake can be re-entered with the right time.
function resolveOccurredAt(events: EventRow[], requested: Date | undefined, now: Date): Date {
  const occurredAt = requested ?? now;
  if (occurredAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new TransitionError("occurred_in_future", "The time cannot be in the future");
  }
  const previous = effectiveEvents(events).at(-1);
  if (previous && occurredAt.getTime() < previous.occurredAt.getTime()) {
    throw new TransitionError(
      "occurred_before_previous",
      `The time cannot be before the previous event (${previous.occurredAt.toISOString()})`,
      { previousOccurredAt: previous.occurredAt },
    );
  }
  return occurredAt;
}

async function staleVersion(tx: Tx, app: ApplicationRow, expectedSeq: number): Promise<StaleVersionError> {
  const [latest] = await tx
    .select({
      recordedAt: applicationEvent.recordedAt,
      actorUserId: applicationEvent.actorUserId,
      name: appUser.name,
      email: appUser.email,
    })
    .from(applicationEvent)
    .leftJoin(appUser, eq(appUser.id, applicationEvent.actorUserId))
    .where(eq(applicationEvent.applicationId, app.id))
    .orderBy(desc(applicationEvent.seq))
    .limit(1);
  const changedBy =
    latest?.actorUserId && latest.email ? { userId: latest.actorUserId, name: latest.name, email: latest.email } : null;
  return new StaleVersionError(expectedSeq, app.eventSeq, changedBy, latest?.recordedAt ?? app.updatedAt);
}

function requireStaff(actor: Actor): Extract<Actor, { type: "staff" }> {
  if (actor.type !== "staff") throw new TransitionError("staff_actor_required", "Only staff can record this");
  return actor;
}

// A live offer: not deleted, response pending or accepted.
async function liveOffer(tx: Tx, applicationId: string) {
  const [row] = await tx
    .select()
    .from(offer)
    .where(
      and(eq(offer.applicationId, applicationId), isNull(offer.deletedAt), inArray(offer.response, ["pending", "accepted"])),
    )
    .orderBy(desc(offer.offeredOn), desc(offer.createdAt))
    .limit(1);
  return row ?? null;
}

async function activeStint(tx: Tx, applicationId: string) {
  const [row] = await tx
    .select()
    .from(hireStint)
    .where(and(eq(hireStint.applicationId, applicationId), isNull(hireStint.voidedAt), eq(hireStint.outcome, "active")))
    .limit(1);
  return row ?? null;
}

async function createStint(tx: Tx, app: ApplicationRow, hire: HireInput, now: Date): Promise<string> {
  const [appRole] = await tx.select({ employerId: role.employerId }).from(role).where(eq(role.id, app.roleId));
  const live = await liveOffer(tx, app.id);
  const id = uuidv7();
  await tx.insert(hireStint).values({
    id,
    personId: app.personId,
    applicationId: app.id,
    origin: "ats",
    employerId: appRole!.employerId,
    roleId: app.roleId,
    openingId: app.openingId,
    isTemporary: hire.isTemporary ?? false,
    plannedEndOn: hire.plannedEndOn ?? null,
    crewOptionId: hire.crewOptionId ?? null,
    plannedStartOn: hire.plannedStartOn ?? live?.plannedStartOn ?? null,
    startOn: hire.startOn ?? null,
    outcome: "active",
    createdAt: now,
  });
  return id;
}

async function voidStint(tx: Tx, stintId: string, kind: "entered_in_error" | "rescinded", reason: string | null, now: Date) {
  await tx
    .update(hireStint)
    .set({ voidedAt: now, voidKind: kind, voidReason: reason })
    .where(and(eq(hireStint.id, stintId), isNull(hireStint.voidedAt)));
}

async function restoreStint(tx: Tx, stintId: string) {
  await tx.update(hireStint).set({ voidedAt: null, voidKind: null, voidReason: null }).where(eq(hireStint.id, stintId));
}

// ---------------------------------------------------------------------------
// Creation: the application row and its `created` event, written together.

export type CreateApplicationInput = {
  personId: string;
  openingId: string;
  origin: ApplicationRow["origin"];
  entryCodeId?: string | null;
  entryChannel: ApplicationRow["entryChannel"];
  scannedSessionId?: string | null;
  source?: ApplicationRow["source"] | null;
  sourceDetail?: string | null;
  language?: string;
  actor: Actor;
  occurredAt?: Date;
  now?: Date;
};

export async function createApplication(
  db: Db,
  input: CreateApplicationInput,
): Promise<{ applicationId: string; eventId: string }> {
  return db.transaction(async (tx) => {
    const now = input.now ?? new Date();
    const occurredAt = input.occurredAt ?? now;
    const [open] = await tx.select().from(opening).where(eq(opening.id, input.openingId));
    if (!open) throw new TransitionError("opening_not_open", "No such opening");
    if (input.origin === "landing" && open.status !== "open") {
      throw new TransitionError("opening_not_open", "This opening is not accepting applications");
    }

    // New applications pin the role's one published form.
    const [form] = await tx
      .select({ id: formVersion.id })
      .from(formVersion)
      .where(and(eq(formVersion.roleId, open.roleId), eq(formVersion.status, "published")));
    if (!form) throw new TransitionError("form_not_published", "The role has no published form");

    if (input.scannedSessionId) {
      const [session] = await tx
        .select({ openingId: groupSession.openingId })
        .from(groupSession)
        .where(eq(groupSession.id, input.scannedSessionId));
      if (session?.openingId !== open.id) {
        throw new TransitionError("session_wrong_opening", "That session belongs to another opening");
      }
    }

    const started = await systemStage(tx, open.roleId, "started");
    const applicationId = uuidv7();
    await tx.insert(application).values({
      id: applicationId,
      personId: input.personId,
      openingId: open.id,
      roleId: open.roleId,
      formVersionId: form.id,
      origin: input.origin,
      status: "open",
      currentStageId: started.id,
      stageEnteredAt: occurredAt,
      eventSeq: 1,
      startedAt: occurredAt,
      lastActivityAt: now,
      language: input.language ?? "en",
      entryCodeId: input.entryCodeId ?? null,
      entryChannel: input.entryChannel,
      scannedSessionId: input.scannedSessionId ?? null,
      attributedSessionId: input.scannedSessionId ?? null,
      attributionMethod: input.scannedSessionId ? "scanned_session" : "none",
      source: input.source ?? null,
      sourceDetail: input.sourceDetail ?? null,
      sourceSetBy: input.source ? input.actor.type : null,
      // Current employees picking up shifts are left out of analysis from the moment they say so.
      excludeFromAnalysis: input.source === "current_employee",
    });

    const eventId = uuidv7();
    await tx.insert(applicationEvent).values({
      id: eventId,
      applicationId,
      seq: 1,
      kind: "created",
      toStageId: started.id,
      toStatus: "open",
      ...actorColumns(input.actor),
      occurredAt,
    });
    return { applicationId, eventId };
  });
}
