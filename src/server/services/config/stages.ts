import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { pipelineStage, role } from "@/db/schema";

// Read-only lookups of roles and their pipelines for the configuration screens.
// Stages are edited by the Phase 2 stage editor; until then they are as seeded.

export type RoleRow = typeof role.$inferSelect;
export type StageRow = typeof pipelineStage.$inferSelect;

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
