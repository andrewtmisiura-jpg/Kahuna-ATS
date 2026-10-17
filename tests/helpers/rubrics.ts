import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { employer, opening, pipelineStage, role } from "@/db/schema";
import { seedPipelines } from "@/db/seed/pipelines";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { addQuestion, ensureDraft } from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";
import type { RubricCriterionInput } from "@/server/services/scoring/rubrics";

// A role of its own for the rubric tests: the snow pipeline, an open opening and a
// published form with three long answers a rubric may read and one never-send question,
// and no rubric yet. Built inside a rolled-back transaction (withRollback), so the
// shared test database keeps exactly the seeded roles other files count.

export type RubricRoleFixture = {
  roleId: string;
  openingId: string;
  // Question lineage ids by key.
  questions: Record<"commitment" | "mistake" | "equipment" | "employer_name", string>;
  // Question version ids by key, for saving answers.
  versions: Record<"commitment" | "mistake" | "equipment" | "employer_name", string>;
};

export const PROMPTS = {
  commitment: "Tell us about the last time you couldn't make a shift you'd agreed to.",
  mistake: "Describe a mistake at work that nobody else noticed.",
  equipment: "You forgot equipment halfway through a job. What do you do?",
} as const;

export async function createRubricRole(db: Db, adminId: string): Promise<RubricRoleFixture> {
  const [emp] = await db.select({ id: employer.id }).from(employer).where(eq(employer.key, "kahuna"));
  const roleId = uuidv7();
  await db.insert(role).values({
    id: roleId,
    employerId: emp!.id,
    key: `rubric_${roleId.slice(-12)}`,
    internalName: "Rubric test role",
    title: "Rubric Test Technician",
    usesGroupInterview: false,
    sortOrder: 98,
  });
  for (const stage of seedPipelines.snow_removal_tech) {
    await db.insert(pipelineStage).values({ id: uuidv7(), roleId, ...stage });
  }

  const actor = staffActor(adminId);
  const draft = await ensureDraft(db, { roleId, actor });
  const long = (key: keyof typeof PROMPTS) =>
    addQuestion(db, { formVersionId: draft.id, sectionKey: "basics", key, type: "long_text", prompt: PROMPTS[key], required: true, actor });
  const added = {
    commitment: await long("commitment"),
    mistake: await long("mistake"),
    equipment: await long("equipment"),
    employer_name: await addQuestion(db, {
      formVersionId: draft.id,
      sectionKey: "basics",
      key: "employer_name",
      type: "short_text",
      prompt: "Your most recent employer?",
      required: false,
      aiNeverSend: true,
      actor,
    }),
  };
  await publishForm(db, { formVersionId: draft.id, changeReason: "Rubric test form", actor });

  const openingId = uuidv7();
  await db.insert(opening).values({ id: openingId, roleId, key: "rubric-test", name: "Rubric Test 2026", status: "open", payText: "$20 an hour", opensOn: "2026-10-01" });

  return {
    roleId,
    openingId,
    questions: {
      commitment: added.commitment.questionId,
      mistake: added.mistake.questionId,
      equipment: added.equipment.questionId,
      employer_name: added.employer_name.questionId,
    },
    versions: {
      commitment: added.commitment.questionVersionId,
      mistake: added.mistake.questionVersionId,
      equipment: added.equipment.questionVersionId,
      employer_name: added.employer_name.questionVersionId,
    },
  };
}

// One criterion for saveRubricDraft, with guidance filled in.
export function criterionInput(name: string, questionIds: string[], overrides: Partial<RubricCriterionInput> = {}): RubricCriterionInput {
  return {
    name,
    weight: 1,
    guidanceStrong: `A specific example of ${name.toLowerCase()}.`,
    guidanceAcceptable: "A general answer.",
    guidanceWeak: "No example.",
    questionIds,
    ...overrides,
  };
}
