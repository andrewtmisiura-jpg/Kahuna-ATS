import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { employer, opening, person, pipelineStage, role, rubric, type ScoringMode } from "@/db/schema";
import { seedPipelines } from "@/db/seed/pipelines";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { saveAnswer } from "@/server/services/applications/answers";
import { createApplication, transition } from "@/server/services/applications/transition";
import { addQuestion, ensureDraft } from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";
import { nextMobile } from "./fixtures";
import { createRubricVersion, ensureRubric, type RubricVersionFixture } from "./phase2";

// A role of its own for the scoring tests: the snow pipeline, a published form with two
// long answers the rubric reads and one never-send question, an open opening and a
// rubric. Built inside a rolled-back transaction (withRollback), so the shared test
// database keeps exactly the seeded roles and openings other files count, and nothing
// another file submits is ever swept into these tests.

export type ScoringRoleFixture = {
  roleId: string;
  openingId: string;
  formVersionId: string;
  // Stage ids by key, e.g. stages.one_on_one_invited.
  stages: Record<string, string>;
  // Question lineage ids by key: commitment, mistake (both read by the rubric) and employer_name (never sent).
  questions: Record<string, string>;
  // Question version ids by key, for saving answers; a test that adds a question adds its version here.
  versions: Record<string, string>;
  rubricId: string;
  // Reliability (weight 2) reads commitment; integrity (weight 1) reads mistake.
  published: RubricVersionFixture;
};

export const COMMITMENT_PROMPT = "Tell us about the last time you couldn't make a shift you'd agreed to.";
export const MISTAKE_PROMPT = "Describe a mistake at work that nobody else noticed.";

export async function createScoringRole(db: Db, options: { adminId: string; mode?: ScoringMode }): Promise<ScoringRoleFixture> {
  const [emp] = await db.select({ id: employer.id }).from(employer).where(eq(employer.key, "kahuna"));
  const roleId = uuidv7();
  await db.insert(role).values({
    id: roleId,
    employerId: emp!.id,
    key: `scoring_${roleId.slice(-12)}`,
    internalName: "Scoring test role",
    title: "Scoring Test Technician",
    usesGroupInterview: false,
    sortOrder: 99,
  });
  const stages: Record<string, string> = {};
  for (const stage of seedPipelines.snow_removal_tech) {
    stages[stage.key] = uuidv7();
    await db.insert(pipelineStage).values({ id: stages[stage.key]!, roleId, ...stage });
  }

  const actor = staffActor(options.adminId);
  const draft = await ensureDraft(db, { roleId, actor });
  const added = {
    commitment: await addQuestion(db, { formVersionId: draft.id, sectionKey: "basics", key: "commitment", type: "long_text", prompt: COMMITMENT_PROMPT, required: true, actor }),
    mistake: await addQuestion(db, { formVersionId: draft.id, sectionKey: "basics", key: "mistake", type: "long_text", prompt: MISTAKE_PROMPT, required: true, actor }),
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
  await publishForm(db, { formVersionId: draft.id, changeReason: "Scoring test form", actor });

  const openingId = uuidv7();
  await db.insert(opening).values({ id: openingId, roleId, key: "scoring-test", name: "Scoring Test 2026", status: "open", payText: "$20 an hour", opensOn: "2026-10-01" });

  const rubricId = await ensureRubric(db, roleId);
  await db.update(rubric).set({ scoringMode: options.mode ?? "visible" }).where(eq(rubric.id, rubricId));
  const published = await createRubricVersion(db, rubricId, {
    published: true,
    publishedBy: options.adminId,
    criteria: [
      { key: "reliability", weight: 2, questionIds: [added.commitment.questionId] },
      { key: "integrity", weight: 1, questionIds: [added.mistake.questionId] },
    ],
  });

  return {
    roleId,
    openingId,
    formVersionId: draft.id,
    stages,
    questions: { commitment: added.commitment.questionId, mistake: added.mistake.questionId, employer_name: added.employer_name.questionId },
    versions: { commitment: added.commitment.questionVersionId, mistake: added.mistake.questionVersionId, employer_name: added.employer_name.questionVersionId },
    rubricId,
    published,
  };
}

export type ApplicantFixture = { firstName?: string; lastName?: string; email?: string; mobile?: string };

// A person who starts an application on the scoring role, answers the given questions
// and submits. The submit goes through transition(), so scoring's part of it runs.
export async function submitScoringApplication(
  db: Db,
  fixture: ScoringRoleFixture,
  // Answers by question key.
  answers: Record<string, string>,
  who: ApplicantFixture = {},
  now: Date = new Date(),
): Promise<{ applicationId: string; personId: string }> {
  const personId = uuidv7();
  const email = who.email ?? `scoring-${personId}@example.test`;
  await db.insert(person).values({
    id: personId,
    firstName: who.firstName ?? "Test",
    lastName: who.lastName ?? "Applicant",
    mobileE164: who.mobile ?? nextMobile(),
    email,
    emailNormalized: email.toLowerCase(),
  });
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: fixture.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: { type: "applicant" },
    occurredAt: new Date(now.getTime() - 60_000),
    now,
  });
  for (const [key, value] of Object.entries(answers)) {
    await saveAnswer(db, { applicationId, questionVersionId: fixture.versions[key]!, revision: 0, value, now });
  }
  await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, now });
  return { applicationId, personId };
}
