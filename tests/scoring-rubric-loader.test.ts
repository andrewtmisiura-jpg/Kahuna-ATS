import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql, type Db } from "@/db";
import { question, questionVersion, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { loadRubricForScoring } from "@/server/services/scoring/rubric-loader";
import { withRollback } from "./helpers/db";
import { TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createRubricVersion, ensureRubric } from "./helpers/phase2";

// loadRubricForScoring: one rubric version as a scorer reads it, for "Try it" on a
// draft and for the scoring job on the published version.

let windowRoleId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  const [windowRole] = await db.select({ id: role.id }).from(role).where(eq(role.key, "window_cleaning_tech"));
  windowRoleId = windowRole!.id;
});

afterAll(async () => {
  await sql.end();
});

// A question lineage on the window role with the given versions, oldest first.
async function lineage(tx: Db, options: { aiNeverSend?: boolean; versions: { prompt: string; published: boolean }[] }) {
  const id = uuidv7();
  const key = `loader_${id.slice(-12)}`;
  await tx.insert(question).values({ id, roleId: windowRoleId, key, aiNeverSend: options.aiNeverSend ?? false });
  for (const [i, version] of options.versions.entries()) {
    await tx.insert(questionVersion).values({
      id: uuidv7(),
      questionId: id,
      version: i + 1,
      type: "long_text",
      prompt: version.prompt,
      publishedAt: version.published ? new Date() : null,
    });
  }
  return { id, key };
}

describe("loadRubricForScoring", () => {
  // Rolled back, so the window role keeps only its seeded questions for other files.
  it("reads criteria in order with weights, guidance and the questions they read", async () => {
    await withRollback(db, async (tx) => {
      const reworded = await lineage(tx, {
        versions: [
          { prompt: "Old published wording", published: true },
          { prompt: "Newer published wording", published: true },
          { prompt: "Unpublished draft wording", published: false },
        ],
      });
      const draftOnly = await lineage(tx, { versions: [{ prompt: "Only a draft so far", published: false }] });
      const neverSend = await lineage(tx, { aiNeverSend: true, versions: [{ prompt: "Who was your employer?", published: true }] });

      const rubricId = await ensureRubric(tx, windowRoleId);
      const created = await createRubricVersion(tx, rubricId, {
        criteria: [
          { key: "reliability", weight: 2.5, questionIds: [reworded.id, neverSend.id] },
          { key: "communication", weight: 1, questionIds: [draftOnly.id] },
          { key: "unread", weight: 0.5 },
        ],
      });

      const loaded = await loadRubricForScoring(tx, created.rubricVersionId);
      expect(loaded).toMatchObject({
        rubricVersionId: created.rubricVersionId,
        instructions: expect.stringContaining("Ignore spelling"),
        allowedFlags: [{ key: "no_answer", label: "Did not answer the question" }],
      });
      expect(loaded!.criteria).toEqual([
        {
          criterionId: created.criteria[0]!.criterionId,
          key: "reliability",
          name: "reliability",
          weight: 2.5,
          guidanceStrong: "A specific example.",
          guidanceAcceptable: "A general answer.",
          guidanceWeak: "No example.",
          // The never-send lineage is dropped; the reworded one carries its newest published wording.
          questions: [{ questionId: reworded.id, key: reworded.key, prompt: "Newer published wording" }],
        },
        expect.objectContaining({ key: "communication", weight: 1, questions: [{ questionId: draftOnly.id, key: draftOnly.key, prompt: "Only a draft so far" }] }),
        expect.objectContaining({ key: "unread", weight: 0.5, questions: [] }),
      ]);
    });
  });

  it("returns null for a version that does not exist", async () => {
    expect(await loadRubricForScoring(db, uuidv7())).toBeNull();
  });
});
