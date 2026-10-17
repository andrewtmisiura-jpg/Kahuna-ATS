"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { MILESTONES } from "@/db/schema";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { staffActor } from "@/server/services/actor";
import { addOpening, createRoleFromTemplate, RoleError } from "@/server/services/config/roles";
import { addStage, archiveStage, moveStage, StageError, unarchiveStage, updateStage } from "@/server/services/config/stages";

// Server actions for Settings > Roles and stages: New role from a template, the stage
// editor and a new role's openings. Admin only. Each one checks the role with
// requireRole, validates the plain input with zod, calls a service and returns a
// result the client can show. Nothing here holds business rules.

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

function describe(error: unknown): string {
  if (error instanceof StageError || error instanceof RoleError) return error.message;
  if (error instanceof NotSignedInError) return "You are signed out. Sign in again.";
  if (error instanceof AccessDeniedError) return error.message === "Access denied" ? "Only an Admin can do this." : error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the form and try again.";
  console.error("[roles action]", error);
  return "Something went wrong. Try again.";
}

async function run<T>(fn: (actor: ReturnType<typeof staffActor>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole("admin");
    return { ok: true, data: await fn(staffActor(user.id)) };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

const uuid = z.uuid({ message: "Something is missing from this form. Reload and try again." });
const milestone = z.enum(MILESTONES, { message: "Pick a milestone from the list" }).nullable();

function revalidateRole(roleId: string) {
  revalidatePath("/admin/settings/roles");
  revalidatePath(`/admin/settings/roles/${roleId}`);
}

// ---------------------------------------------------------------------------
// New role

const createRoleSchema = z.object({
  templateRoleId: uuid,
  title: z.string(),
  internalName: z.string(),
  key: z.string(),
  copyQuestions: z.boolean(),
});

export async function createRoleAction(input: z.infer<typeof createRoleSchema>): Promise<ActionResult<{ roleId: string }>> {
  return run(async (actor) => {
    const parsed = createRoleSchema.parse(input);
    const created = await createRoleFromTemplate(db, { actor, ...parsed });
    revalidatePath("/admin/settings/roles");
    revalidatePath("/admin/questions");
    return { roleId: created.roleId };
  });
}

// ---------------------------------------------------------------------------
// Stage editor

const addStageSchema = z.object({
  roleId: uuid,
  name: z.string(),
  publicLabel: z.string(),
  milestone,
  showOnBoard: z.boolean(),
  afterStageId: uuid,
});

export async function addStageAction(input: z.infer<typeof addStageSchema>): Promise<ActionResult> {
  return run(async (actor) => {
    const parsed = addStageSchema.parse(input);
    await addStage(db, { actor, ...parsed });
    revalidateRole(parsed.roleId);
    return null;
  });
}

const stagePatchSchema = z.object({
  name: z.string().optional(),
  publicLabel: z.string().optional(),
  milestone: milestone.optional(),
  showOnBoard: z.boolean().optional(),
});

export async function updateStageAction(input: { stageId: string; patch: z.infer<typeof stagePatchSchema> }): Promise<ActionResult> {
  return run(async (actor) => {
    const stage = await updateStage(db, { actor, stageId: uuid.parse(input.stageId), patch: stagePatchSchema.parse(input.patch) });
    revalidateRole(stage.roleId);
    return null;
  });
}

export async function moveStageAction(input: { stageId: string; direction: "up" | "down"; roleId: string }): Promise<ActionResult> {
  return run(async (actor) => {
    const parsed = z.object({ stageId: uuid, direction: z.enum(["up", "down"]), roleId: uuid }).parse(input);
    await moveStage(db, { actor, stageId: parsed.stageId, direction: parsed.direction });
    revalidateRole(parsed.roleId);
    return null;
  });
}

export async function archiveStageAction(input: { stageId: string }): Promise<ActionResult> {
  return run(async (actor) => {
    const stage = await archiveStage(db, { actor, stageId: uuid.parse(input.stageId) });
    revalidateRole(stage.roleId);
    return null;
  });
}

export async function unarchiveStageAction(input: { stageId: string }): Promise<ActionResult> {
  return run(async (actor) => {
    const stage = await unarchiveStage(db, { actor, stageId: uuid.parse(input.stageId) });
    revalidateRole(stage.roleId);
    return null;
  });
}

// ---------------------------------------------------------------------------
// A role's openings

const openingSchema = z.object({ roleId: uuid, name: z.string(), key: z.string() });

export async function addOpeningAction(input: z.infer<typeof openingSchema>): Promise<ActionResult<{ openingId: string }>> {
  return run(async (actor) => {
    const parsed = openingSchema.parse(input);
    const created = await addOpening(db, { actor, ...parsed });
    revalidateRole(parsed.roleId);
    revalidatePath("/admin/settings/openings");
    return created;
  });
}
