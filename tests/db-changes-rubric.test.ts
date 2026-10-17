import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { CHANGES, runChanges } from "@/db/changes";
import { snowBehavioralQuestions } from "@/db/changes/snow-behavioral-questions";
import {
  SNOW_STARTER_CHANGE_REASON,
  SNOW_STARTER_CRITERIA,
  SNOW_STARTER_FLAGS,
  SNOW_STARTER_INSTRUCTIONS,
  SNOW_STARTER_TEST_CASES,
  snowStarterRubric,
} from "@/db/changes/snow-starter-rubric";
import { appliedChange, auditLog, employer, question, role, rubric, rubricTestCase, rubricVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { fakeScorer } from "@/server/services/scoring/fake";
import { loadRubricForScoring } from "@/server/services/scoring/rubric-loader";
import { getOrCreateRubric, loadRubricVersion } from "@/server/services/scoring/rubrics";
import { tryRubricVersion } from "@/server/services/scoring/test-cases";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// The snow starter rubric, the second one-time content change (src/db/changes). Other
// test files give the snow role a rubric of their own in the shared database, so each
// case runs in a rolled-back transaction and, where it needs snow without one, parks
// that rubric on a throwaway role first.

const ID = "2026-10-16-snow-starter-rubric";
const SNOW_CHANGES = [snowBehavioralQuestions, snowStarterRubric];

let snow: SnowFixture;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Moves a rubric another file gave snow onto a new role, so snow has none (rolled back).
async function parkSnowRubric(tx: Tx) {
  const [existing] = await tx.select({ id: rubric.id }).from(rubric).where(eq(rubric.roleId, snow.roleId));
  if (!existing) return;
  const [emp] = await tx.select({ id: employer.id }).from(employer).where(eq(employer.key, "kahuna"));
  const parked = uuidv7();
  await tx.insert(role).values({ id: parked, employerId: emp!.id, key: `parked_${parked.slice(-12)}`, internalName: "Parked", title: "Parked", usesGroupInterview: false, sortOrder: 97 });
  await tx.update(rubric).set({ roleId: parked }).where(eq(rubric.id, existing.id));
}

async function snowRubric(tx: Tx) {
  const [row] = await tx.select().from(rubric).where(eq(rubric.roleId, snow.roleId));
  return row ?? null;
}

describe("the change list", () => {
  it("lists the snow starter rubric after the snow questions it reads", () => {
    const ids = CHANGES.map((change) => change.id);
    expect(ids).toContain(ID);
    expect(ids.indexOf(ID)).toBeGreaterThan(ids.indexOf(snowBehavioralQuestions.id));
  });
});

describe("the snow starter rubric change", () => {
  it("publishes version 1 with the owner's four criteria, turns scoring to visible and adds the samples, through the services", async () => {
    await withRollback(db, async (tx) => {
      await parkSnowRubric(tx);
      const lines: string[] = [];
      expect(await runChanges(tx, SNOW_CHANGES, (line) => lines.push(line))).toEqual({ applied: [snowBehavioralQuestions.id, ID], skipped: [] });
      expect(lines.join("\n")).toContain("snow removal rubric version 1 published: Reliability 30, Integrity 25, Work ethic 30, Problem solving 15");

      const row = (await snowRubric(tx))!;
      expect(row.scoringMode).toBe("visible");
      const versions = await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, row.id));
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        version: 1,
        status: "published",
        changeReason: SNOW_STARTER_CHANGE_REASON,
        publishedBy: adminId,
        instructions: SNOW_STARTER_INSTRUCTIONS,
        allowedFlags: SNOW_STARTER_FLAGS.map((flag) => ({ ...flag })),
      });
      expect(SNOW_STARTER_CHANGE_REASON).toBe(
        "Starter rubric from the owner's notes on the snow questions (Oct 16, 2026). The owner asked for snow to be scored.",
      );

      // Four criteria in order, each reading exactly its own question, the Blue question none.
      const lineages = await tx
        .select({ id: question.id, key: question.key, aiNeverSend: question.aiNeverSend })
        .from(question)
        .where(eq(question.roleId, snow.roleId));
      const keyOf = new Map(lineages.map((lineage) => [lineage.id, lineage.key]));
      const view = (await loadRubricVersion(tx, versions[0]!.id))!;
      expect(view.criteria.map((c) => [c.key, c.name, c.weight, c.questionIds.map((id) => keyOf.get(id)), c.meaningChanged])).toEqual([
        ["reliability", "Reliability", 30, ["missed_commitment"], false],
        ["integrity", "Integrity", 25, ["unnoticed_mistake"], false],
        ["work_ethic", "Work ethic", 30, ["hardest_physical_job"], false],
        ["problem_solving", "Problem solving", 15, ["forgot_equipment"], false],
      ]);
      for (const [index, criterion] of view.criteria.entries()) {
        const source = SNOW_STARTER_CRITERIA[index]!;
        expect([criterion.guidanceStrong, criterion.guidanceAcceptable, criterion.guidanceWeak]).toEqual([
          source.guidanceStrong,
          source.guidanceAcceptable,
          source.guidanceWeak,
        ]);
      }
      const read = view.criteria.flatMap((c) => c.questionIds);
      expect(read.map((id) => keyOf.get(id))).not.toContain("best_boss_blue");
      expect(lineages.filter((lineage) => read.includes(lineage.id) && lineage.aiNeverSend)).toEqual([]);

      // Scored as the job will read it: each criterion with its question's published wording.
      const forScoring = (await loadRubricForScoring(tx, view.id))!;
      expect(forScoring.criteria.map((c) => c.questions.map((q) => q.key))).toEqual([
        ["missed_commitment"],
        ["unnoticed_mistake"],
        ["hardest_physical_job"],
        ["forgot_equipment"],
      ]);

      // Two groups, each written three ways, answering the four questions, with no numbers.
      const samples = await tx.select().from(rubricTestCase).where(eq(rubricTestCase.rubricId, row.id)).orderBy(asc(rubricTestCase.groupKey));
      expect(samples.map((s) => [s.groupKey, s.variant]).sort()).toEqual(
        [
          ["red_flag_answers", "broken_english"],
          ["red_flag_answers", "short"],
          ["red_flag_answers", "standard"],
          ["solid_answers", "broken_english"],
          ["solid_answers", "short"],
          ["solid_answers", "standard"],
        ].sort(),
      );
      for (const s of samples) {
        expect(Object.keys(s.answers).sort()).toEqual(["forgot_equipment", "hardest_physical_job", "missed_commitment", "unnoticed_mistake"]);
        for (const answer of Object.values(s.answers)) expect(answer).not.toMatch(/\d/);
      }
      expect(SNOW_STARTER_TEST_CASES).toHaveLength(samples.length);

      // Try it on the starter with the stand-in scorer: every sample 51, no spread.
      const tried = await tryRubricVersion(tx, { rubricVersionId: view.id, scorer: fakeScorer });
      if (!tried.ok) throw new Error(tried.message);
      expect(tried.groups.map((g) => [g.groupKey, g.results.map((r) => r.overallScore), g.spread])).toEqual([
        ["red_flag_answers", [51, 51, 51], 0],
        ["solid_answers", [51, 51, 51], 0],
      ]);

      // Through the services, so every step is audited as the Admin.
      const actions = await tx
        .select({ action: auditLog.action, actor: auditLog.actorUserId })
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.entityId, [row.id, view.id, ...samples.map((s) => s.id)]),
            inArray(auditLog.action, ["rubric.create", "rubric.draft_create", "rubric.draft_update", "config.publish", "rubric.mode_change", "rubric_test_case.create"]),
          ),
        );
      expect(actions.map((a) => a.action).sort()).toEqual(
        [
          "config.publish",
          "rubric.create",
          "rubric.draft_create",
          "rubric.draft_update",
          "rubric.mode_change",
          ...samples.map(() => "rubric_test_case.create"),
        ].sort(),
      );
      expect(new Set(actions.map((a) => a.actor))).toEqual(new Set([adminId]));
      const [applied] = await tx.select().from(appliedChange).where(eq(appliedChange.id, ID));
      expect(applied?.description).toBe(snowStarterRubric.description);

      // The second run does nothing.
      expect(await runChanges(tx, SNOW_CHANGES)).toEqual({ applied: [], skipped: [snowBehavioralQuestions.id, ID] });
      expect(await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, row.id))).toHaveLength(1);
      expect(await tx.select().from(rubricTestCase).where(eq(rubricTestCase.rubricId, row.id))).toHaveLength(samples.length);
    });
  });

  it("does nothing, and says so, when snow already has a rubric", async () => {
    await withRollback(db, async (tx) => {
      const rubricId = await getOrCreateRubric(tx, { roleId: snow.roleId, actor: staffActor(adminId) });
      const before = {
        versions: await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, rubricId)),
        samples: await tx.select().from(rubricTestCase).where(eq(rubricTestCase.rubricId, rubricId)),
        mode: (await snowRubric(tx))!.scoringMode,
      };
      const lines: string[] = [];
      const report = await runChanges(tx, SNOW_CHANGES, (line) => lines.push(line));
      expect(report.applied).toContain(ID);
      expect(lines.join("\n")).toContain("snow removal already has a rubric, so nothing was changed");

      expect(await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, rubricId))).toEqual(before.versions);
      expect(await tx.select().from(rubricTestCase).where(eq(rubricTestCase.rubricId, rubricId))).toEqual(before.samples);
      expect((await snowRubric(tx))!.scoringMode).toBe(before.mode);
    });
  });

  it("refuses, and changes nothing, when the snow questions it reads are missing", async () => {
    await withRollback(db, async (tx) => {
      await parkSnowRubric(tx);
      // Only the starter, on a snow role without the owner's questions under those keys.
      const keys = SNOW_STARTER_CRITERIA.map((criterion) => criterion.questionKey);
      for (const key of keys) {
        await tx.update(question).set({ key: `${key}_renamed` }).where(and(eq(question.roleId, snow.roleId), eq(question.key, key)));
      }
      await expect(runChanges(tx, [snowStarterRubric])).rejects.toThrow(/missed_commitment, unnoticed_mistake, hardest_physical_job, forgot_equipment do not exist/);
      expect(await snowRubric(tx)).toBeNull();
      expect(await tx.select().from(appliedChange).where(eq(appliedChange.id, ID))).toHaveLength(0);
    });
  });
});
