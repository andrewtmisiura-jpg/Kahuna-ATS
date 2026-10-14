"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { useMemo, useState } from "react";
import { CloseDialog } from "@/components/admin/applicants/close-dialog";
import { ActionNotice } from "@/components/admin/applicants/fields";
import { fullName } from "@/components/admin/applicants/format";
import { HireFormDialog } from "@/components/admin/applicants/hire-form-dialog";
import { MoveDialog, stageNeedsDetails } from "@/components/admin/applicants/move-dialog";
import { useAdminAction } from "@/components/admin/applicants/use-admin-action";
import { loadHireStintAction, moveCardAction } from "@/server/actions/admin/board";
import type { UserRole } from "@/server/auth/roles";
import type { Board, BoardCard } from "@/server/services/applications/board";
import type { Profile, ProfileStint } from "@/server/services/applications/queries";
import { CardBody, type CardState } from "./board-card";
import { BoardColumnView, CLOSE_ZONE_ID, CloseZone, type ShownCard } from "./board-column";
import { columnCoordinates } from "./keyboard";
import { MoveBackDialog } from "./move-back-dialog";

// The board's drag and drop (PLAN.md, Admin list, Kanban). A drop into a plain
// stage moves the card at once with the version it was rendered with: the card
// shows in its new column while the move saves and snaps back if the move is
// refused. A stale version says who changed the application and when, then the
// page data reloads. Drops into Offer, Check or Hired open the list's Move
// dialog (and the hire form after Hired); the Close zone opens the Close dialog.
// Moving back to an earlier stage asks first. Cancel snaps the card back.

type Props = {
  board: Board;
  openingId: string;
  picklists: Profile["picklists"];
  isSnow: boolean;
  role: UserRole;
  canAct: boolean;
};

// A move laid over the server data until the server catches up. baseSeq is the
// card's version when it was dropped: once the server's version moves on, the
// entry no longer applies and the card shows where the server has it.
type PendingMove = { toStageId: string; baseSeq: number; state: Exclude<CardState, "idle"> };

type DialogState =
  | { kind: "back"; card: BoardCard; toStageId: string }
  | { kind: "move"; card: BoardCard; toStageId: string }
  | { kind: "close"; card: BoardCard }
  | { kind: "hire"; stint: ProfileStint }
  | null;

// The pointer decides when there is one; keyboard drags have none, so the card's rectangle does.
const detectCollisions: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

export function BoardView({ board, openingId, picklists, isSnow, role, canAct }: Props) {
  const [pending, setPending] = useState<Record<string, PendingMove>>({});
  const [dialog, setDialog] = useState<DialogState>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { run, failure, clear } = useAdminAction();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }),
  );

  const cards = useMemo(() => new Map(board.columns.flatMap((column) => column.cards).map((card) => [card.id, card])), [board]);
  const stagesById = useMemo(() => new Map(board.stages.map((stage) => [stage.id, stage])), [board]);

  const columns = useMemo(() => {
    const shown = board.columns.map((column) => ({ stage: column.stage, cards: [] as ShownCard[] }));
    const byStage = new Map(shown.map((column) => [column.stage.id, column]));
    const moved: { card: BoardCard; move: PendingMove }[] = [];
    for (const column of board.columns) {
      for (const card of column.cards) {
        const move = pending[card.id];
        const live = move && move.baseSeq === card.eventSeq && byStage.has(move.toStageId) ? move : null;
        if (live && live.toStageId !== card.stageId) moved.push({ card, move: live });
        else byStage.get(card.stageId)?.cards.push({ card, state: live?.state ?? "idle" });
      }
    }
    // A moved card has just entered its stage, so it goes to the bottom, where the server will put it.
    for (const { card, move } of moved) byStage.get(move.toStageId)!.cards.push({ card, state: move.state });
    return shown;
  }, [board, pending]);

  const nameOf = (id: UniqueIdentifier) => {
    const card = cards.get(String(id));
    return card ? fullName(card.firstName, card.lastName) : "The card";
  };
  const targetName = (id: UniqueIdentifier) => (id === CLOSE_ZONE_ID ? "Close" : (stagesById.get(String(id))?.name ?? "a column"));

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} is over ${targetName(over.id)}.` : `${nameOf(active.id)} is not over a column.`),
    onDragEnd: ({ active, over }) => (over ? `${nameOf(active.id)} dropped on ${targetName(over.id)}.` : `${nameOf(active.id)} was not moved.`),
    onDragCancel: ({ active }) => `Move canceled. ${nameOf(active.id)} stays where it was.`,
  };

  function hold(card: BoardCard, toStageId: string, state: PendingMove["state"]) {
    setPending((prev) => ({ ...prev, [card.id]: { toStageId, baseSeq: card.eventSeq, state } }));
  }

  function release(cardId: string) {
    setPending((prev) => {
      if (!(cardId in prev)) return prev;
      const next = { ...prev };
      delete next[cardId];
      return next;
    });
  }

  // A plain stage: optimistic, then transition() with the card's version. Any
  // refusal snaps the card back; a stale version also reloads the data (useAdminAction).
  function save(card: BoardCard, toStageId: string) {
    hold(card, toStageId, "saving");
    run(async () => {
      const result = await moveCardAction({ applicationId: card.id, expectedSeq: card.eventSeq, toStageId });
      if (!result.ok) release(card.id);
      return result;
    });
  }

  async function openHireForm(stintId: string) {
    const result = await loadHireStintAction({ stintId });
    if (result.ok && result.data) setDialog({ kind: "hire", stint: result.data });
  }

  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
    setNotice(null);
    clear();
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    const card = cards.get(String(active.id));
    if (!card || !over) return;

    if (over.id === CLOSE_ZONE_ID) {
      if (card.status === "hired") {
        setNotice(
          `${fullName(card.firstName, card.lastName)} is hired, and a hire is not closed. To record that they never started or have left, open the profile and edit the hire record.`,
        );
        return;
      }
      hold(card, card.stageId, "waiting");
      setDialog({ kind: "close", card });
      return;
    }

    const toStageId = String(over.id);
    const from = stagesById.get(card.stageId);
    const to = stagesById.get(toStageId);
    if (!to || toStageId === card.stageId) return;

    if (from && to.sortOrder < from.sortOrder) {
      hold(card, toStageId, "waiting");
      setDialog({ kind: "back", card, toStageId });
      return;
    }
    if (stageNeedsDetails(to)) {
      hold(card, toStageId, "waiting");
      setDialog({ kind: "move", card, toStageId });
      return;
    }
    save(card, toStageId);
  }

  function confirmBack(card: BoardCard, toStageId: string) {
    if (stageNeedsDetails(stagesById.get(toStageId))) {
      setDialog({ kind: "move", card, toStageId });
      return;
    }
    setDialog(null);
    save(card, toStageId);
  }

  function cancel(card: BoardCard) {
    setDialog(null);
    release(card.id);
  }

  const activeCard = activeId ? cards.get(activeId) : undefined;

  return (
    <div>
      {canAct ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Drag a card to another column to move it. With a keyboard, focus the card&apos;s grip, press Space, pick a column with the arrow keys and press
          Space again.
        </p>
      ) : null}
      <ActionNotice failure={failure} className="mb-3" />
      {notice ? (
        <div role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {notice}
        </div>
      ) : null}

      <DndContext
        id="tidepool-board"
        sensors={sensors}
        collisionDetection={detectCollisions}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "To move this card, press Space or Enter, use the left and right arrow keys to pick a column, then press Space or Enter to drop it. Press Escape to cancel.",
          },
        }}
      >
        <div data-board className="flex items-stretch gap-3 overflow-x-auto pb-4">
          {columns.map((column) => (
            <BoardColumnView key={column.stage.id} stage={column.stage} cards={column.cards} openingId={openingId} canAct={canAct} />
          ))}
          {canAct ? <CloseZone /> : null}
        </div>
        <DragOverlay dropAnimation={null}>{activeCard ? <CardBody card={activeCard} openingId={openingId} overlay /> : null}</DragOverlay>
      </DndContext>

      {dialog?.kind === "back" ? (
        <MoveBackDialog
          open
          name={fullName(dialog.card.firstName, dialog.card.lastName)}
          stageName={stagesById.get(dialog.toStageId)?.name ?? "that stage"}
          fromHired={dialog.card.status === "hired"}
          onConfirm={() => confirmBack(dialog.card, dialog.toStageId)}
          onCancel={() => cancel(dialog.card)}
        />
      ) : null}

      {dialog?.kind === "move" ? (
        <MoveDialog
          open
          onOpenChange={(open) => {
            if (!open) cancel(dialog.card);
          }}
          stages={board.stages}
          crews={picklists.crews}
          initialStageId={dialog.toStageId}
          target={{ applicationId: dialog.card.id, eventSeq: dialog.card.eventSeq, currentStageId: dialog.card.stageId }}
          onDone={(result) => {
            if (!("created" in result)) return;
            // The dialog closed itself just before this; keep the card where it went while the page reloads.
            hold(dialog.card, result.stageId, "saving");
            if (result.created.hireStintId) void openHireForm(result.created.hireStintId);
          }}
        />
      ) : null}

      {dialog?.kind === "close" ? (
        <CloseDialog
          open
          onOpenChange={(open) => {
            if (!open) cancel(dialog.card);
          }}
          application={{ id: dialog.card.id, eventSeq: dialog.card.eventSeq }}
          picklists={picklists}
          checks={board.checks[dialog.card.id] ?? []}
        />
      ) : null}

      {dialog?.kind === "hire" ? (
        <HireFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          stint={dialog.stint}
          crews={picklists.crews}
          leaveReasons={picklists.leaveReasons}
          isSnow={isSnow}
          role={role}
        />
      ) : null}
    </div>
  );
}
