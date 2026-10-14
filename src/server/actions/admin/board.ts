"use server";

import { z } from "zod";
import { db } from "@/db";
import { requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";
import { staffActor } from "@/server/services/actor";
import { loadBoardStint, moveBoardCard, type BoardMoveResult } from "@/server/services/applications/board";
import type { ProfileStint } from "@/server/services/applications/queries";
import { toActionFailure, type ActionResult } from "./application-errors";

// The board's own actions. A drop into a plain stage moves the card through
// transition() with the version the card was rendered with; drops that need
// details go through the list's Move and Close dialogs and their actions.
// Each action starts with requireRole; Viewers can look at the board but never move a card.

const ACTORS: readonly UserRole[] = ["admin", "hiring_manager"];

async function run<T>(fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(ACTORS);
    return { ok: true, data: await fn(user) };
  } catch (error) {
    return toActionFailure(error);
  }
}

const moveSchema = z.object({
  applicationId: z.uuid(),
  expectedSeq: z.number().int().nonnegative(),
  toStageId: z.uuid(),
});

export async function moveCardAction(raw: z.input<typeof moveSchema>): Promise<ActionResult<BoardMoveResult>> {
  return run(async (user) => {
    const input = moveSchema.parse(raw);
    return moveBoardCard(db, { ...input, actor: staffActor(user.id) });
  });
}

// The hire record a drop into Hired created, so the hire form can open on it.
export async function loadHireStintAction(raw: { stintId: string }): Promise<ActionResult<ProfileStint | null>> {
  return run(async () => {
    const input = z.object({ stintId: z.uuid() }).parse(raw);
    return loadBoardStint(db, input.stintId);
  });
}
