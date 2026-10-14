import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { application, applicationEvent, formVersion, opening, person, pipelineStage, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

export const TEST_ADMIN_EMAIL = "admin@example.test";

export type SnowFixture = {
  roleId: string;
  openingId: string;
  formVersionId: string;
  startedStageId: string;
};

// The seeded snow role, its open opening, published form and Started stage.
export async function loadSnow(db: Db): Promise<SnowFixture> {
  const [snow] = await db.select({ id: role.id }).from(role).where(eq(role.key, "snow_removal_tech"));
  if (!snow) throw new Error("snow role missing: run the seed first");
  const [open] = await db
    .select({ id: opening.id })
    .from(opening)
    .where(and(eq(opening.roleId, snow.id), eq(opening.status, "open")));
  const [form] = await db
    .select({ id: formVersion.id })
    .from(formVersion)
    .where(and(eq(formVersion.roleId, snow.id), eq(formVersion.status, "published")));
  const [started] = await db
    .select({ id: pipelineStage.id })
    .from(pipelineStage)
    .where(and(eq(pipelineStage.roleId, snow.id), eq(pipelineStage.key, "started")));
  if (!open || !form || !started) throw new Error("snow opening, form or stage missing");
  return { roleId: snow.id, openingId: open.id, formVersionId: form.id, startedStageId: started.id };
}

let counter = 0;

// A fresh US mobile number for each call, so partial uniques never collide by accident.
export function nextMobile() {
  counter += 1;
  return `+1612555${String(counter).padStart(4, "0")}`;
}

export async function createPerson(db: Db, overrides: Partial<typeof person.$inferInsert> = {}) {
  const id = uuidv7();
  await db.insert(person).values({
    id,
    firstName: "Test",
    lastName: "Person",
    mobileE164: nextMobile(),
    email: `person-${id}@example.test`,
    emailNormalized: `person-${id}@example.test`,
    ...overrides,
  });
  return id;
}

// A started snow application with its `created` event, the way the landing service will write it.
export async function createApplication(db: Db, snow: SnowFixture, personId: string) {
  const id = uuidv7();
  const now = new Date();
  await db.insert(application).values({
    id,
    personId,
    openingId: snow.openingId,
    roleId: snow.roleId,
    formVersionId: snow.formVersionId,
    origin: "landing",
    currentStageId: snow.startedStageId,
    stageEnteredAt: now,
    eventSeq: 1,
    startedAt: now,
    lastActivityAt: now,
    entryChannel: "role_qr",
  });
  const eventId = uuidv7();
  await db.insert(applicationEvent).values({
    id: eventId,
    applicationId: id,
    seq: 1,
    kind: "created",
    toStageId: snow.startedStageId,
    toStatus: "open",
    actorType: "applicant",
    occurredAt: now,
  });
  return { applicationId: id, eventId };
}
