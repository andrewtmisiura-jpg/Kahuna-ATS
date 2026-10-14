import type { applicationEvent } from "@/db/schema";

// One pure function replays an application's events into its cached columns
// (DATA_MODEL.md, "Transitions, replay and voiding"). The transition function and
// the report tests both use it, so they cannot disagree.

export type EventRow = typeof applicationEvent.$inferSelect;
export type EventKind = EventRow["kind"];
export type ApplicationStatus = NonNullable<EventRow["toStatus"]>;
export type ClosedOutcome = NonNullable<EventRow["closedOutcome"]>;

export type CachedState = {
  currentStageId: string;
  stageEnteredAt: Date;
  status: ApplicationStatus;
  closedOutcome: ClosedOutcome | null;
  closedReasonOptionId: string | null;
  onHold: boolean;
  startedAt: Date;
  submittedAt: Date | null;
  answersLocked: boolean;
  eventSeq: number;
};

// Events that change the cached state and may therefore be voided (only the latest one).
export const STATE_CHANGING_KINDS: readonly EventKind[] = [
  "stage_changed",
  "closed",
  "reopened",
  "hold_set",
  "hold_cleared",
  "hire_rescinded",
];

// Events that can never be voided.
export const NEVER_VOIDED_KINDS: readonly EventKind[] = ["created", "submitted", "event_voided", "person_merged"];

// The fields voiding needs, so the profile's event shape works here too.
type VoidableEvent = Pick<EventRow, "id" | "seq" | "kind" | "voidsEventId">;

export function voidedEventIds(events: readonly VoidableEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === "event_voided" && event.voidsEventId) ids.add(event.voidsEventId);
  }
  return ids;
}

// The events that count: in seq order, without event_voided rows and without the
// events they voided.
export function effectiveEvents<T extends VoidableEvent>(events: readonly T[]): T[] {
  const voided = voidedEventIds(events);
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => event.kind !== "event_voided" && !voided.has(event.id));
}

// The one event "Undo last change" may void: the latest state-changing event that
// still counts. Null when nothing after creation and submission changed the state.
export function latestStateChange<T extends VoidableEvent>(events: readonly T[]): T | null {
  return (
    effectiveEvents(events)
      .filter((event) => STATE_CHANGING_KINDS.includes(event.kind))
      .at(-1) ?? null
  );
}

export function replayEvents(events: readonly EventRow[]): CachedState {
  const effective = effectiveEvents(events);
  const created = effective[0];
  if (!created || created.kind !== "created" || !created.toStageId) {
    throw new Error("An application's first event must be `created` with a stage");
  }

  const state: CachedState = {
    currentStageId: created.toStageId,
    stageEnteredAt: created.occurredAt,
    status: created.toStatus ?? "open",
    closedOutcome: null,
    closedReasonOptionId: null,
    onHold: false,
    startedAt: created.occurredAt,
    submittedAt: null,
    answersLocked: false,
    eventSeq: 0,
  };

  const enterStage = (event: EventRow) => {
    if (event.toStageId && event.toStageId !== state.currentStageId) {
      state.currentStageId = event.toStageId;
      state.stageEnteredAt = event.occurredAt;
    }
  };

  for (const event of effective.slice(1)) {
    switch (event.kind) {
      case "submitted":
        state.submittedAt = event.occurredAt;
        state.answersLocked = true;
        enterStage(event);
        break;
      case "stage_changed":
        enterStage(event);
        if (event.toStatus) state.status = event.toStatus;
        break;
      case "closed":
        state.status = "closed";
        state.closedOutcome = event.closedOutcome;
        state.closedReasonOptionId = event.reasonOptionId;
        break;
      case "reopened":
        state.status = "open";
        state.closedOutcome = null;
        state.closedReasonOptionId = null;
        enterStage(event);
        break;
      case "hold_set":
        state.onHold = true;
        break;
      case "hold_cleared":
        state.onHold = false;
        break;
      case "hire_rescinded":
        state.status = event.toStatus ?? "open";
        state.closedOutcome = state.status === "closed" ? event.closedOutcome : null;
        state.closedReasonOptionId = state.status === "closed" ? event.reasonOptionId : null;
        enterStage(event);
        break;
      case "contacted":
      case "person_merged":
        break;
      default:
        throw new Error(`Unexpected event kind ${event.kind} in replay`);
    }
  }

  // The concurrency column counts every row, voided ones and the void itself included.
  state.eventSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return state;
}
