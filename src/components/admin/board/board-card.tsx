"use client";

import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { formatShortDay, fullName } from "@/components/admin/applicants/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BoardCard } from "@/server/services/applications/board";

// One applicant on the board: name (opens the profile), entry code or session,
// submitted date, days in stage, and the badges staff scan for. The whole card
// drags with a pointer; the grip is the keyboard handle.

// idle: where the server has it. saving: a move is on its way. waiting: a dialog is open for it.
export type CardState = "idle" | "saving" | "waiting";

export function daysInStageLabel(days: number): string {
  return days === 1 ? "1 day in stage" : `${Math.max(0, days)} days in stage`;
}

export function profileHref(cardId: string, openingId: string): Route {
  return `/admin/applicants/${cardId}?opening=${openingId}` as Route;
}

type BodyProps = {
  card: BoardCard;
  openingId: string;
  state?: CardState;
  handle?: React.ReactNode;
  overlay?: boolean;
};

export function CardBody({ card, openingId, state = "idle", handle, overlay = false }: BodyProps) {
  const name = fullName(card.firstName, card.lastName);
  const where = card.sessionLabel ?? card.entryCode;
  const grip = overlay ? (
    <span className="-ml-1 mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
      <GripVertical className="size-4" />
    </span>
  ) : (
    handle
  );
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-2.5 text-sm shadow-xs",
        overlay && "w-60 rotate-1 shadow-lg",
        state !== "idle" && "border-dashed opacity-70",
      )}
    >
      <div className="flex items-start gap-1">
        {grip}
        <div className="min-w-0 flex-1">
          {overlay ? (
            <span className="block truncate font-medium">{name}</span>
          ) : (
            <Link href={profileHref(card.id, openingId)} draggable={false} className="block truncate font-medium hover:underline">
              {name}
            </Link>
          )}
          <p className="truncate text-xs text-muted-foreground" title={card.sessionLabel ? undefined : (card.entryCodeLabel ?? undefined)}>
            {where ?? "No entry code"}
          </p>
          <p className="text-xs text-muted-foreground">
            Submitted {formatShortDay(card.submittedAt)} · {daysInStageLabel(card.daysInStage)}
          </p>
        </div>
      </div>
      <CardBadges card={card} />
      {state === "saving" ? <p className="mt-1 text-xs text-muted-foreground">Saving</p> : null}
    </div>
  );
}

function CardBadges({ card }: { card: BoardCard }) {
  const badges: React.ReactNode[] = [];
  if (card.onHold) badges.push(<Badge key="hold" variant="outline">On hold</Badge>);
  if (card.unhandledTexts > 0) badges.push(<Badge key="texts" variant="secondary">Texts ({card.unhandledTexts})</Badge>);
  if (card.returning !== "none") {
    badges.push(
      <Badge key="returning" variant={card.returning === "not_rehire_eligible" ? "destructive" : "secondary"}>
        {card.returning === "not_rehire_eligible" ? "Returning, not rehire eligible" : "Returning"}
      </Badge>,
    );
  }
  if (card.temporary) badges.push(<Badge key="temporary" variant="outline">Temporary</Badge>);
  if (badges.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap gap-1">{badges}</div>;
}

type DraggableProps = { card: BoardCard; openingId: string; state: CardState; canAct: boolean };

export function DraggableCard({ card, openingId, state, canAct }: DraggableProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id,
    data: { stageId: card.stageId },
    disabled: !canAct || state !== "idle",
  });
  const name = fullName(card.firstName, card.lastName);
  const handle = canAct ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      aria-label={`Move ${name}`}
      className="-ml-1 mt-0.5 flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  ) : null;
  return (
    <li ref={setNodeRef} {...listeners} data-card-id={card.id} data-version={card.eventSeq} className={cn(canAct && state === "idle" && "cursor-grab", isDragging && "opacity-40")}>
      <CardBody card={card} openingId={openingId} state={state} handle={handle} />
    </li>
  );
}
