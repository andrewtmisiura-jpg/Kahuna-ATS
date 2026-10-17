import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { formVersion, opening, pipelineStage, role } from "@/db/schema";
import { createApplication, createPerson, type SnowFixture } from "./fixtures";

// Fixtures for the interviews area's tests (interviews, assessments, stages, roles),
// written straight to the tables the way the services will.

export type WindowFixture = SnowFixture;

// The seeded window role, its draft opening and form, and its Started stage. The
// window form is still a draft in a fresh seed, so an application made here pins it
// directly, which the landing service never would; tests that make one do it inside
// withRollback so nothing outlives them.
export async function loadWindow(db: Db): Promise<WindowFixture> {
  const [windowRole] = await db.select({ id: role.id }).from(role).where(eq(role.key, "window_cleaning_tech"));
  if (!windowRole) throw new Error("window role missing: run the seed first");
  const [windowOpening] = await db.select({ id: opening.id }).from(opening).where(eq(opening.roleId, windowRole.id));
  const [form] = await db
    .select({ id: formVersion.id })
    .from(formVersion)
    .where(and(eq(formVersion.roleId, windowRole.id), eq(formVersion.version, 1)));
  const [started] = await db
    .select({ id: pipelineStage.id })
    .from(pipelineStage)
    .where(and(eq(pipelineStage.roleId, windowRole.id), eq(pipelineStage.key, "started")));
  if (!windowOpening || !form || !started) throw new Error("window opening, form or stage missing");
  return { roleId: windowRole.id, openingId: windowOpening.id, formVersionId: form.id, startedStageId: started.id };
}

// A started application with its created event on the given role fixture.
export async function newApplication(db: Db, fixture: SnowFixture): Promise<{ applicationId: string; personId: string }> {
  const personId = await createPerson(db);
  const { applicationId } = await createApplication(db, fixture, personId);
  return { applicationId, personId };
}
