import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { applicationEvent, picklistOption, type Milestone } from "@/db/schema";
import type { Actor } from "../actor";
import { effectiveEvents, latestStateChange, STATE_CHANGING_KINDS, type EventRow } from "./replay";
import { transition, TransitionError, type CloseInput, type TransitionResult } from "./transition";

// Two corrections on the profile (DATA_MODEL.md, "Transitions, replay and
// voiding"): rescinding a hire that really fell through, and undoing the latest
// change as a mistake. Both go through transition(), so the append-only event log
// (actor, entry time, the voided flag) is the record; nothing is edited in place.

// ---------------------------------------------------------------------------
// Rescind a hire

export type RescindTarget = { status: "open"; toStageId: string } | ({ status: "closed" } & CloseInput);

export type RescindHireInput = {
  applicationId: string;
  actor: Actor;
  expectedSeq?: number;
  occurredAt?: Date;
  note?: string | null;
  to: RescindTarget;
  now?: Date;
};

// A rescission needs a reason: the closed reason picked from its list, or a note.
// Going back to a stage has no list, so it needs the note. The hire record keeps
// the reason as its void reason.
export async function rescindHire(db: Db, input: RescindHireInput): Promise<TransitionResult> {
  const note = input.note?.trim() || null;
  let label: string | null = null;
  if (input.to.status === "closed") {
    const [option] = await db.select({ label: picklistOption.label }).from(picklistOption).where(eq(picklistOption.id, input.to.reasonOptionId));
    // transition() validates the reason itself; a missing one fails there with reason_not_found.
    label = option?.label ?? null;
  }
  const voidReason = [label, note].filter(Boolean).join(": ");
  if (!voidReason) {
    throw new TransitionError(
      "note_required",
      input.to.status === "open" ? "Write why the hire is rescinded" : "Pick a reason or write why the hire is rescinded",
    );
  }
  return transition(db, {
    action: "rescind_hire",
    applicationId: input.applicationId,
    actor: input.actor,
    expectedSeq: input.expectedSeq,
    occurredAt: input.occurredAt,
    note,
    now: input.now,
    voidReason,
    to: input.to,
  });
}

// The stage a rescinded hire goes back to by default: the stage the person was in
// just before the move into Hired, else the last stage before Hired in the pipeline.
export function stageBeforeHire(
  events: readonly Pick<EventRow, "id" | "seq" | "kind" | "voidsEventId" | "fromStageId" | "toStatus">[],
  stages: readonly { id: string; milestone: Milestone | null; sortOrder: number }[],
): string | null {
  const choices = stages.filter((s) => s.milestone !== "hired");
  const entered = effectiveEvents(events)
    .filter((e) => e.kind === "stage_changed" && e.toStatus === "hired")
    .at(-1);
  if (entered?.fromStageId && choices.some((s) => s.id === entered.fromStageId)) return entered.fromStageId;
  const hired = stages.find((s) => s.milestone === "hired");
  const before = choices.filter((s) => !hired || s.sortOrder < hired.sortOrder).sort((a, b) => a.sortOrder - b.sortOrder);
  return before.at(-1)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Undo the latest change

export type UndoLastChangeInput = {
  applicationId: string;
  actor: Actor;
  expectedSeq: number;
  // The event the confirmation named. The void refuses it unless it is still the
  // latest change, and the expected seq refuses anything changed since the page loaded.
  eventId: string;
  now?: Date;
};

export async function undoLastChange(db: Db, input: UndoLastChangeInput): Promise<TransitionResult> {
  const [target] = await db
    .select({ kind: applicationEvent.kind, applicationId: applicationEvent.applicationId })
    .from(applicationEvent)
    .where(eq(applicationEvent.id, input.eventId));
  if (!target || target.applicationId !== input.applicationId) {
    throw new TransitionError("event_not_found", "No such change on this application");
  }
  if (!STATE_CHANGING_KINDS.includes(target.kind)) {
    throw new TransitionError("event_not_voidable", "Only a move, close, reopen, hold or rescinded hire can be undone");
  }
  return transition(db, {
    action: "void",
    applicationId: input.applicationId,
    actor: input.actor,
    expectedSeq: input.expectedSeq,
    eventId: input.eventId,
    now: input.now,
  });
}

export type UndoPreview = {
  eventId: string;
  // What the change was, e.g. "Moved from Submitted to Reviewed".
  summary: string;
  occurredAt: Date;
  actorName: string | null;
  // What undoing it does, in plain words.
  effects: string[];
};

export type PreviewEvent = Pick<
  EventRow,
  "id" | "seq" | "kind" | "voidsEventId" | "toStatus" | "closedOutcome" | "metadata" | "occurredAt" | "actorType"
> & {
  fromStage: string | null;
  toStage: string | null;
  reasonLabel: string | null;
  actorName: string | null;
};

const OUTCOMES: Record<NonNullable<EventRow["closedOutcome"]>, string> = {
  disqualified: "Disqualified",
  withdrew: "Withdrew",
  not_selected: "Not selected",
};

function closedAs(event: PreviewEvent): string {
  const outcome = event.closedOutcome ? OUTCOMES[event.closedOutcome] : "closed";
  return event.reasonLabel ? `${outcome} (${event.reasonLabel})` : outcome;
}

// What the confirmation names: the change "Undo last change" would void, or null.
// messageQueued: the invite or decline that change queued has not gone out yet.
export function undoPreview(events: readonly PreviewEvent[], messageQueued = false): UndoPreview | null {
  const event = latestStateChange(events);
  if (!event) return null;
  const m = event.metadata ?? {};
  const effects: string[] = [];
  let summary: string;
  switch (event.kind) {
    case "stage_changed":
      summary = `Moved from ${event.fromStage ?? "?"} to ${event.toStage ?? "?"}`;
      effects.push(`The application goes back to ${event.fromStage ?? "the stage before"}.`);
      if (m.offer_id) effects.push("The offer this move created is removed.");
      if (m.background_check_id) effects.push("The background check this move created is canceled.");
      if (m.hire_stint_id) effects.push("The hire record this move created is marked entered in error.");
      if (m.voided_hire_stint_id) effects.push("The application is hired again and its hire record comes back.");
      if (messageQueued) effects.push("The one-on-one invite this move queued is canceled before it goes out.");
      break;
    case "closed":
      summary = `Closed as ${closedAs(event)}`;
      effects.push("The application is open again, in the same stage.");
      if (messageQueued) effects.push("The decline message this close queued is canceled before it goes out.");
      break;
    case "reopened":
      summary = `Reopened into ${event.toStage ?? "the same stage"}`;
      effects.push("The application is closed again with its earlier outcome and reason.");
      break;
    case "hold_set":
      summary = "Put on hold";
      effects.push("The hold comes off.");
      break;
    case "hold_cleared":
      summary = "Taken off hold";
      effects.push("The application goes back on hold.");
      break;
    case "hire_rescinded":
      summary =
        event.toStatus === "closed"
          ? `Hire rescinded and closed as ${closedAs(event)}`
          : `Hire rescinded, back to ${event.toStage ?? "an earlier stage"}`;
      effects.push(m.rescinded_hire_stint_id ? "The application is hired again and its hire record comes back." : "The application is hired again.");
      break;
    default:
      return null;
  }
  effects.push("The change stays in the stage history, marked voided.");
  return {
    eventId: event.id,
    summary,
    occurredAt: event.occurredAt,
    actorName: event.actorType === "staff" ? event.actorName : event.actorType === "applicant" ? "the applicant" : "the system",
    effects,
  };
}
