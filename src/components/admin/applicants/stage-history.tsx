import type { ProfileEvent } from "@/server/services/applications/queries";
import { EVENT_LABELS, formatDateTime, OUTCOME_LABELS } from "./format";
import { Section } from "./section";

// The append-only log, newest first: occurred and recorded times, actor, reason,
// note and the voided flag.

function describe(event: ProfileEvent): string {
  switch (event.kind) {
    case "stage_changed":
      return `${event.fromStage ?? "?"} to ${event.toStage ?? "?"}${event.toStatus === "hired" ? " (hired)" : event.toStatus === "open" && event.fromStage ? "" : ""}`;
    case "closed":
      return `${event.closedOutcome ? OUTCOME_LABELS[event.closedOutcome] : "Closed"}${event.reasonLabel ? `: ${event.reasonLabel}` : ""}${event.notReportBased ? " (does not rely on the background report)" : ""}`;
    case "reopened":
      return `to ${event.toStage ?? "the same stage"}`;
    case "hire_rescinded":
      return event.toStatus === "closed" ? `closed as ${event.closedOutcome ? OUTCOME_LABELS[event.closedOutcome] : ""}${event.reasonLabel ? `: ${event.reasonLabel}` : ""}` : `back to ${event.toStage ?? "open"}`;
    case "created":
    case "submitted":
      return event.toStage ?? "";
    default:
      return "";
  }
}

export function StageHistory({ events }: { events: ProfileEvent[] }) {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  return (
    <Section title="Stage history">
      <ol className="grid gap-3">
        {ordered.map((event) => {
          const entryLag = event.recordedAt.getTime() - event.occurredAt.getTime() > 5 * 60_000;
          return (
            <li key={event.id} className={event.voided ? "opacity-60" : ""}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">
                  {EVENT_LABELS[event.kind] ?? event.kind}
                  {event.voided ? " (voided)" : ""}
                </span>
                <span className="text-muted-foreground">{describe(event)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(event.occurredAt)}
                {entryLag ? `, entered ${formatDateTime(event.recordedAt)}` : ""}
                {" · "}
                {event.actorType === "staff" ? (event.actorName ?? "staff") : event.actorType === "applicant" ? "the applicant" : "the system"}
              </p>
              {event.note ? <p className="mt-0.5 whitespace-pre-wrap text-sm">{event.note}</p> : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
