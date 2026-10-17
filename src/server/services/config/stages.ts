import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application, applicationEvent, MILESTONES, pipelineStage, role, type Milestone } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { slugKey, uniqueKey } from "@/server/services/forms/keys";

// Roles and their pipelines for the configuration screens, and the stage editor in
// Settings > Roles and stages (DATA_MODEL.md, pipeline_stage and "Report keys never
// change once used"). An Admin adds a custom stage, renames a stage, edits the label
// applicants see, reorders with up and down, shows or hides it on the board, and
// archives or unarchives it. A stage's key and role never change; the editor has no
// such call. The lock rules:
//   - Started and Submitted are system stages: the app moves applications into them,
//     so they are never archived, moved or remapped, and no stage goes above them.
//   - Once any application_event names a stage, its milestone is fixed. To remap,
//     archive it and add a replacement, so past funnels and stage times never change.
//   - Milestones never go backward along the live pipeline. Custom stages (no
//     milestone) sit anywhere, and several stages may share a milestone.
//   - A stage holding open applications is not archived; the refusal gives the count.
//   - A role keeps one live Hired stage, which Hire now and the hire form move into.
// Every change is audited.

export type RoleRow = typeof role.$inferSelect;
export type StageRow = typeof pipelineStage.$inferSelect;

export type StageErrorCode =
  | "role_not_found"
  | "stage_not_found"
  | "invalid_input"
  | "name_taken"
  | "system_stage_locked"
  | "milestone_locked"
  | "milestone_reserved"
  | "milestone_order"
  | "stage_has_open_applications"
  | "last_hired_stage"
  | "stage_archived";

export class StageError extends Error {
  constructor(
    readonly code: StageErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StageError";
  }
}

// How each milestone reads on screen and in the editor's messages.
export const MILESTONE_LABELS: Record<Milestone, string> = {
  started: "Started",
  submitted: "Submitted",
  reviewed: "Reviewed",
  interview_invited: "Interview invited",
  interviewed: "Interviewed",
  offered: "Offered",
  background_check: "Background check",
  hired: "Hired",
};

// The milestones only the two system stages carry: the app moves applications into them.
const SYSTEM_MILESTONES: readonly Milestone[] = ["started", "submitted"];

export const STAGE_NAME_MAX_LENGTH = 60;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function listRoles(db: Db): Promise<RoleRow[]> {
  return db.select().from(role).where(isNull(role.archivedAt)).orderBy(asc(role.sortOrder), asc(role.internalName));
}

export async function getRole(db: Db, roleId: string): Promise<RoleRow | null> {
  const [row] = await db.select().from(role).where(eq(role.id, roleId));
  return row ?? null;
}

// A role's live stages in pipeline order.
export async function listStages(db: Db, roleId: string): Promise<StageRow[]> {
  return db
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.roleId, roleId), isNull(pipelineStage.archivedAt)))
    .orderBy(asc(pipelineStage.sortOrder));
}

export type EditorStage = StageRow & {
  // An application_event names the stage, so its milestone is fixed.
  inUse: boolean;
  // Open applications sitting in the stage now.
  openCount: number;
};

// Every stage of a role, archived ones included, in pipeline order, with what the
// lock rules need to know.
export async function listStagesForEditor(db: Db, roleId: string): Promise<EditorStage[]> {
  // The subqueries name the outer row in full: drizzle leaves columns unqualified in a
  // one-table select, and a bare "id" would resolve inside the subquery.
  const rows = await db
    .select({
      stage: pipelineStage,
      inUse: sql<boolean>`exists (select 1 from application_event e where e.from_stage_id = "pipeline_stage"."id" or e.to_stage_id = "pipeline_stage"."id")`,
      openCount: sql<number>`(select count(*)::int from application a where a.current_stage_id = "pipeline_stage"."id" and a.status = 'open' and a.deleted_at is null)`,
    })
    .from(pipelineStage)
    .where(eq(pipelineStage.roleId, roleId))
    .orderBy(asc(pipelineStage.sortOrder), asc(pipelineStage.createdAt));
  return rows.map((row) => ({ ...row.stage, inUse: Boolean(row.inUse), openCount: Number(row.openCount) }));
}

type OrderedStage = Pick<StageRow, "id" | "name" | "milestone" | "sortOrder" | "archivedAt">;

function byPipelineOrder<T extends Pick<StageRow, "sortOrder">>(a: T, b: T) {
  return a.sortOrder - b.sortOrder;
}

// The first live stage whose milestone comes before the milestone of a stage above
// it, with that stage; null when the live pipeline reads in milestone order.
export function milestoneOrderProblem<T extends OrderedStage>(stages: readonly T[]): { stage: T; above: T } | null {
  let highest: T | null = null;
  for (const stage of stages.filter((s) => !s.archivedAt).sort(byPipelineOrder)) {
    if (!stage.milestone) continue;
    const index = MILESTONES.indexOf(stage.milestone);
    if (highest && index < MILESTONES.indexOf(highest.milestone!)) return { stage, above: highest };
    if (!highest || index >= MILESTONES.indexOf(highest.milestone!)) highest = stage;
  }
  return null;
}

function orderError(problem: { stage: OrderedStage; above: OrderedStage }): StageError {
  const { stage, above } = problem;
  return new StageError(
    "milestone_order",
    `"${stage.name}" (${MILESTONE_LABELS[stage.milestone!]}) cannot come after "${above.name}" (${MILESTONE_LABELS[above.milestone!]}): stages follow the order of the hiring steps.`,
  );
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name) throw new StageError("invalid_input", "Give the stage a name");
  if (name.length > STAGE_NAME_MAX_LENGTH) throw new StageError("invalid_input", `Keep the name under ${STAGE_NAME_MAX_LENGTH} characters`);
  return name;
}

function cleanPublicLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new StageError("invalid_input", "Write what applicants see for this stage");
  if (label.length > STAGE_NAME_MAX_LENGTH) throw new StageError("invalid_input", `Keep what applicants see under ${STAGE_NAME_MAX_LENGTH} characters`);
  return label;
}

function cleanMilestone(value: string | null | undefined): Milestone | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(MILESTONES as readonly string[]).includes(value)) throw new StageError("invalid_input", "Pick a milestone from the list");
  return value as Milestone;
}

function checkNameFree(stages: readonly StageRow[], name: string, exceptId?: string) {
  const taken = stages.some((s) => !s.archivedAt && s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new StageError("name_taken", `Another stage of this role is already called "${name}"`);
}

// Every editor change takes the role row's lock first, so two changes to one pipeline
// apply one after the other.
async function lockRole(tx: Tx, roleId: string): Promise<RoleRow> {
  const [row] = await tx.select().from(role).where(eq(role.id, roleId)).for("update");
  if (!row) throw new StageError("role_not_found", "No such role");
  return row;
}

async function loadAll(tx: Tx, roleId: string): Promise<StageRow[]> {
  const rows = await tx.select().from(pipelineStage).where(eq(pipelineStage.roleId, roleId));
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
}

// Locks the stage's role and returns the stage with all of the role's stages.
async function lockStage(tx: Tx, stageId: string): Promise<{ stage: StageRow; stages: StageRow[] }> {
  const [found] = await tx.select({ roleId: pipelineStage.roleId }).from(pipelineStage).where(eq(pipelineStage.id, stageId));
  if (!found) throw new StageError("stage_not_found", "No such stage");
  await lockRole(tx, found.roleId);
  const stages = await loadAll(tx, found.roleId);
  return { stage: stages.find((s) => s.id === stageId)!, stages };
}

async function stageInUse(tx: Tx, stageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: applicationEvent.id })
    .from(applicationEvent)
    .where(or(eq(applicationEvent.fromStageId, stageId), eq(applicationEvent.toStageId, stageId)))
    .limit(1);
  return Boolean(row);
}

async function openApplicationCount(tx: Tx, stageId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(application)
    .where(and(eq(application.currentStageId, stageId), eq(application.status, "open"), isNull(application.deletedAt)));
  return Number(row?.n ?? 0);
}

function checkKeepsHired(stages: readonly StageRow[], stage: StageRow) {
  if (stage.milestone !== "hired" || stage.archivedAt) return;
  const others = stages.some((s) => s.id !== stage.id && !s.archivedAt && s.milestone === "hired");
  if (!others) {
    throw new StageError("last_hired_stage", "Every role keeps a Hired stage: Hire now and the hire form move people into it. Add another Hired stage first.");
  }
}

// Writes sort orders 10, 20, 30 in the given order, touching only rows that change.
async function renumber(tx: Tx, ordered: readonly StageRow[], now: Date) {
  for (const [i, stage] of ordered.entries()) {
    const sortOrder = (i + 1) * 10;
    if (stage.sortOrder !== sortOrder) {
      await tx.update(pipelineStage).set({ sortOrder, updatedAt: now }).where(eq(pipelineStage.id, stage.id));
    }
  }
}

export type AddStageInput = {
  actor: Actor;
  roleId: string;
  name: string;
  publicLabel: string;
  // Null for a custom stage such as "Phone screen".
  milestone: Milestone | null;
  showOnBoard: boolean;
  // The live stage the new one follows: Submitted at the earliest.
  afterStageId: string;
  now?: Date;
};

// The key is made from the name once, never shown for editing and never changed.
export async function addStage(db: Db, input: AddStageInput): Promise<StageRow> {
  const name = cleanName(input.name);
  const publicLabel = cleanPublicLabel(input.publicLabel);
  const milestone = cleanMilestone(input.milestone);
  if (milestone && SYSTEM_MILESTONES.includes(milestone)) {
    throw new StageError("milestone_reserved", "Started and Submitted belong to the two system stages. Pick a later milestone, or none.");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await lockRole(tx, input.roleId);
    const stages = await loadAll(tx, input.roleId);
    const live = stages.filter((s) => !s.archivedAt);
    const after = live.find((s) => s.id === input.afterStageId);
    if (!after) throw new StageError("stage_not_found", "Pick the stage the new one comes after");
    const lastSystem = live.findLastIndex((s) => s.isSystem);
    if (live.indexOf(after) < lastSystem) throw new StageError("system_stage_locked", "New stages go after Submitted");
    checkNameFree(stages, name);

    const key = uniqueKey(slugKey(name, 40), new Set(stages.map((s) => s.key)), "stage");
    const id = uuidv7();
    const next = stages[stages.indexOf(after) + 1];
    const roomAfter = !next || next.sortOrder - after.sortOrder >= 2;
    const sortOrder = !next ? after.sortOrder + 10 : roomAfter ? Math.floor((after.sortOrder + next.sortOrder) / 2) : after.sortOrder + 1;

    const candidate = { id, name, milestone, sortOrder, archivedAt: null };
    const ordered = [...stages.slice(0, stages.indexOf(after) + 1), candidate, ...stages.slice(stages.indexOf(after) + 1)];
    const problem = milestoneOrderProblem(ordered.map((s, i) => ({ ...s, sortOrder: i })));
    if (problem) throw orderError(problem);

    const [row] = await tx
      .insert(pipelineStage)
      .values({ id, roleId: input.roleId, key, name, publicLabel, milestone, sortOrder, isSystem: false, showOnBoard: input.showOnBoard, createdAt: now, updatedAt: now })
      .returning();
    if (!roomAfter) {
      await renumber(tx, [...stages.slice(0, stages.indexOf(after) + 1), row!, ...stages.slice(stages.indexOf(after) + 1)], now);
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "pipeline_stage.add",
      entityType: "pipeline_stage",
      entityId: id,
      changes: {
        roleId: { from: null, to: input.roleId },
        key: { from: null, to: key },
        name: { from: null, to: name },
        publicLabel: { from: null, to: publicLabel },
        milestone: { from: null, to: milestone },
        showOnBoard: { from: null, to: input.showOnBoard },
        afterStageId: after.id,
      },
      occurredAt: now,
    });
    const [saved] = await tx.select().from(pipelineStage).where(eq(pipelineStage.id, id));
    return saved!;
  });
}

export type StagePatch = {
  name?: string;
  publicLabel?: string;
  milestone?: Milestone | null;
  showOnBoard?: boolean;
};

const AUDITED = ["name", "publicLabel", "milestone", "showOnBoard"] as const;

// Name, public label and the board toggle are always editable. The milestone follows
// the lock rules.
export async function updateStage(db: Db, input: { actor: Actor; stageId: string; patch: StagePatch; now?: Date }): Promise<StageRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const { stage: before, stages } = await lockStage(tx, input.stageId);
    const p = input.patch;
    const next = {
      name: p.name === undefined ? before.name : cleanName(p.name),
      publicLabel: p.publicLabel === undefined ? before.publicLabel : cleanPublicLabel(p.publicLabel),
      milestone: p.milestone === undefined ? before.milestone : cleanMilestone(p.milestone),
      showOnBoard: p.showOnBoard ?? before.showOnBoard,
    };
    if (next.name !== before.name) checkNameFree(stages, next.name, before.id);

    if (next.milestone !== before.milestone) {
      if (before.isSystem) {
        throw new StageError("system_stage_locked", `${before.name} is a system stage: the app moves applications into it, so its milestone never changes.`);
      }
      if (next.milestone && SYSTEM_MILESTONES.includes(next.milestone)) {
        throw new StageError("milestone_reserved", "Started and Submitted belong to the two system stages. Pick a later milestone, or none.");
      }
      if (await stageInUse(tx, before.id)) {
        throw new StageError(
          "milestone_locked",
          "Applications have already been through this stage, so its milestone stays as it is. To count it differently, archive it and add a new stage.",
        );
      }
      checkKeepsHired(stages, before);
      const problem = milestoneOrderProblem(stages.map((s) => (s.id === before.id ? { ...s, milestone: next.milestone } : s)));
      if (problem) throw orderError(problem);
    }

    const [after] = await tx.update(pipelineStage).set({ ...next, updatedAt: now }).where(eq(pipelineStage.id, before.id)).returning();
    const changes = diffChanges(before, after!, AUDITED);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "pipeline_stage.update",
        entityType: "pipeline_stage",
        entityId: before.id,
        changes,
        occurredAt: now,
      });
    }
    return after!;
  });
}

// Swaps a live stage with the live stage above or below it. Archived stages keep their
// places in between.
export async function moveStage(db: Db, input: { actor: Actor; stageId: string; direction: "up" | "down"; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const { stage, stages } = await lockStage(tx, input.stageId);
    if (stage.archivedAt) throw new StageError("stage_archived", "Unarchive the stage before moving it");
    const live = stages.filter((s) => !s.archivedAt);
    const index = live.indexOf(stage);
    const neighbor = live[input.direction === "up" ? index - 1 : index + 1];
    if (!neighbor) return;
    if (stage.isSystem || neighbor.isSystem) {
      throw new StageError("system_stage_locked", "Started and Submitted are system stages: they stay first, in that order.");
    }

    const ordered = [...stages];
    const a = ordered.indexOf(stage);
    const b = ordered.indexOf(neighbor);
    [ordered[a], ordered[b]] = [neighbor, stage];
    const problem = milestoneOrderProblem(ordered.map((s, i) => ({ ...s, sortOrder: i })));
    if (problem) throw orderError(problem);

    await renumber(tx, ordered, now);
    await writeAudit(tx, {
      actor: input.actor,
      action: "pipeline_stage.move",
      entityType: "pipeline_stage",
      entityId: stage.id,
      changes: {
        position: { from: index + 1, to: live.indexOf(neighbor) + 1 },
        direction: input.direction,
        swappedWithStageId: neighbor.id,
      },
      occurredAt: now,
    });
  });
}

// Archived stages leave the pipeline, the board and the move dialog; applications
// already in one keep pointing at it, and reports keep it.
export async function archiveStage(db: Db, input: { actor: Actor; stageId: string; now?: Date }): Promise<StageRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const { stage: before, stages } = await lockStage(tx, input.stageId);
    if (before.archivedAt) return before;
    if (before.isSystem) {
      throw new StageError("system_stage_locked", `${before.name} is a system stage: the app moves applications into it, so it cannot be archived.`);
    }
    const open = await openApplicationCount(tx, before.id);
    if (open > 0) {
      throw new StageError(
        "stage_has_open_applications",
        `${open} open application${open === 1 ? " is" : "s are"} in this stage. Move ${open === 1 ? "it" : "them"} to another stage first.`,
        { openCount: open },
      );
    }
    checkKeepsHired(stages, before);
    const [after] = await tx.update(pipelineStage).set({ archivedAt: now, updatedAt: now }).where(eq(pipelineStage.id, before.id)).returning();
    await writeAudit(tx, {
      actor: input.actor,
      action: "pipeline_stage.archive",
      entityType: "pipeline_stage",
      entityId: before.id,
      changes: diffChanges(before, after!, ["archivedAt"]),
      occurredAt: now,
    });
    return after!;
  });
}

// Back in the pipeline where it was, if its name is still free and its milestone still
// fits the order around it.
export async function unarchiveStage(db: Db, input: { actor: Actor; stageId: string; now?: Date }): Promise<StageRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const { stage: before, stages } = await lockStage(tx, input.stageId);
    if (!before.archivedAt) return before;
    checkNameFree(stages, before.name, before.id);
    const problem = milestoneOrderProblem(stages.map((s) => (s.id === before.id ? { ...s, archivedAt: null } : s)));
    if (problem) throw orderError(problem);
    const [after] = await tx.update(pipelineStage).set({ archivedAt: null, updatedAt: now }).where(eq(pipelineStage.id, before.id)).returning();
    await writeAudit(tx, {
      actor: input.actor,
      action: "pipeline_stage.unarchive",
      entityType: "pipeline_stage",
      entityId: before.id,
      changes: diffChanges(before, after!, ["archivedAt"]),
      occurredAt: now,
    });
    return after!;
  });
}
