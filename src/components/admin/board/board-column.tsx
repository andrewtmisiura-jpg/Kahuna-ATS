"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import type { BoardCard, BoardStage } from "@/server/services/applications/board";
import { DraggableCard, type CardState } from "./board-card";

// A stage column and the Close zone at the end of the board. Both are drop
// targets; the region label is the stage name so screen readers and tests can
// find a column by name.

export const CLOSE_ZONE_ID = "close";

export type ShownCard = { card: BoardCard; state: CardState };

type ColumnProps = { stage: BoardStage; cards: ShownCard[]; openingId: string; canAct: boolean };

export function BoardColumnView({ stage, cards, openingId, canAct }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: !canAct });
  return (
    <section
      ref={setNodeRef}
      aria-label={stage.name}
      className={cn("flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30 transition-colors", isOver && "border-primary/60 bg-primary/5")}
    >
      <header className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-2">
        <h2 className="truncate text-sm font-medium">{stage.name}</h2>
        <span className="text-xs text-muted-foreground" aria-label={`${cards.length} ${cards.length === 1 ? "card" : "cards"}`}>
          {cards.length}
        </span>
      </header>
      {cards.length > 0 ? (
        <ul className="grid max-h-[65dvh] content-start gap-2 overflow-y-auto px-2 pb-2">
          {cards.map(({ card, state }) => (
            <DraggableCard key={card.id} card={card} openingId={openingId} state={state} canAct={canAct} />
          ))}
        </ul>
      ) : (
        <p className="px-3 pb-3 text-xs text-muted-foreground">No cards</p>
      )}
    </section>
  );
}

export function CloseZone() {
  const { setNodeRef, isOver } = useDroppable({ id: CLOSE_ZONE_ID });
  return (
    <section
      ref={setNodeRef}
      aria-label="Close"
      className={cn(
        "flex w-44 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-3 text-center transition-colors",
        isOver ? "border-destructive/60 bg-destructive/5" : "border-muted-foreground/30",
      )}
    >
      <h2 className="text-sm font-medium">Close</h2>
      <p className="text-xs text-muted-foreground">Drop a card here to close it as disqualified, withdrew or not selected.</p>
    </section>
  );
}
