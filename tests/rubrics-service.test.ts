import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, employer, question, reviewDecision, rubric, rubricCriterion, rubricVersion, rubricVersionCriterion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { createApplication, transition } from "@/server/services/applications/transition";
import { ConfigError } from "@/server/services/config/errors";
import { scoringCallsOn } from "@/server/services/scoring/jobs";
import {
  checkRubricDraft,
  DEFAULT_INSTRUCTIONS,
  discardRubricDraft,
  ensureRubricDraft,
  getScoringCap,
  loadCalibration,
  loadRoleRubric,
  loadRubricQuestions,
  loadRubricVersion,
  publishRubricVersion,
  RubricError,
  saveRubricDraft,
  setScoringMode,
  updateScoringDailyCap,
  validWeight,
  type RubricCriterionInput,
} from "@/server/services/scoring/rubrics";
import { centralDate } from "@/server/services/time";
import { expectPgError, PG, withRollback } from "./helpers/db";
import { createPerson, loadAdminId, loadOption, loadSnow, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createAiScore } from "./helpers/phase2";
import { createRubricRole, criterionInput, type RubricRoleFixture } from "./helpers/rubrics";

// The rubric editor's service (scoring/rubrics.ts): drafts, saving, publishing with a
// reason, the scoring mode and the daily limit. Every case builds its own role inside a
// rolled-back transaction, so the shared test database keeps the seeded roles.

let adminId: string;
let actor: ReturnType<typeof staffActor>;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
  actor = staffActor(adminId);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function expectRubricError(run: Promise<unknown>, code: RubricError["code"], message?: RegExp) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected RubricError ${code}`).toBeInstanceOf(RubricError);
  expect((caught as RubricError).code).toBe(code);
  if (message) expect((caught as RubricError).message).toMatch(message);
}

// Reliability (weight 2) reads the commitment question; integrity (weight 1) the mistake one.
function twoCriteria(role: RubricRoleFixture): RubricCriterionInput[] {
  return [
    criterionInput("Reliability", [role.questions.commitment], { weight: 2 }),
    criterionInput("Integrity", [role.questions.mistake], { weight: 1 }),
  ];
}

async function publishedRubric(tx: Tx, role: RubricRoleFixture, reason = "First rubric for the test role") {
  const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
  await saveRubricDraft(tx, { rubricVersionId: draft.id, instructions: "Grade the behavior.", allowedFlags: [], criteria: twoCriteria(role), actor });
  await publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason: reason, actor });
  return draft;
}

async function audits(tx: Tx, entityId: string) {
  return tx.select().from(auditLog).where(eq(auditLog.entityId, entityId));
}

describe("drafts", () => {
  it("creates the rubric with scoring off and starts an empty first draft, once", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      expect(draft).toMatchObject({ version: 1, status: "draft", instructions: DEFAULT_INSTRUCTIONS, allowedFlags: [], criteria: [] });

      const [row] = await tx.select().from(rubric).where(eq(rubric.roleId, role.roleId));
      expect(row!.scoringMode).toBe("off");
      expect((await audits(tx, row!.id)).map((a) => a.action)).toEqual(["rubric.create"]);
      expect((await audits(tx, draft.id)).map((a) => a.action)).toEqual(["rubric.draft_create"]);

      // A second start returns the same draft.
      expect((await ensureRubricDraft(tx, { roleId: role.roleId, actor })).id).toBe(draft.id);
      expect(await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, row!.id))).toHaveLength(1);
    });
  });

  it("saves instructions, flags and criteria in order, deriving keys, and audits what changed", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      const saved = await saveRubricDraft(tx, {
        rubricVersionId: draft.id,
        instructions: "  Grade the behavior, not the writing.  ",
        allowedFlags: [{ label: "Blames others for their own mistake" }, { key: "no_call_no_show", label: "Missed work without telling anyone" }],
        criteria: [
          criterionInput("Reliability", [role.questions.commitment], { weight: 2.5 }),
          criterionInput("Problem solving", [role.questions.equipment, role.questions.mistake], { weight: 0.75 }),
        ],
        actor,
      });
      expect(saved.instructions).toBe("Grade the behavior, not the writing.");
      expect(saved.allowedFlags).toEqual([
        { key: "blames_others_for_their_own_mistake", label: "Blames others for their own mistake" },
        { key: "no_call_no_show", label: "Missed work without telling anyone" },
      ]);
      expect(saved.criteria.map((c) => [c.key, c.name, c.weight, c.questionIds])).toEqual([
        ["reliability", "Reliability", 2.5, [role.questions.commitment]],
        ["problem_solving", "Problem solving", 0.75, [role.questions.equipment, role.questions.mistake]],
      ]);

      const [entry] = (await audits(tx, draft.id)).filter((a) => a.action === "rubric.draft_update");
      expect(entry!.actorUserId).toBe(adminId);
      expect(entry!.changes).toMatchObject({ criteriaAdded: ["reliability", "problem_solving"], instructions: { to: "Grade the behavior, not the writing." } });

      // Reordered and reweighted: the same criteria, the new order.
      const reordered = await saveRubricDraft(tx, {
        rubricVersionId: draft.id,
        instructions: saved.instructions,
        allowedFlags: saved.allowedFlags,
        criteria: [
          { ...saved.criteria[1]!, weight: 1 },
          { ...saved.criteria[0]! },
        ],
        actor,
      });
      expect(reordered.criteria.map((c) => [c.key, c.weight])).toEqual([
        ["problem_solving", 1],
        ["reliability", 2.5],
      ]);
      const changes = (await audits(tx, draft.id)).filter((a) => a.action === "rubric.draft_update").at(-1)!.changes;
      expect(changes).toMatchObject({ criteriaEdited: ["problem_solving"], criteriaReordered: true });

      // Saving what is already there writes no audit row.
      const before = (await audits(tx, draft.id)).length;
      await saveRubricDraft(tx, { rubricVersionId: draft.id, instructions: reordered.instructions, allowedFlags: reordered.allowedFlags, criteria: reordered.criteria, actor });
      expect(await audits(tx, draft.id)).toHaveLength(before);
    });
  });

  it("refuses what a rubric cannot hold, in plain words", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      const save = (patch: { instructions?: string; allowedFlags?: { key?: string; label: string }[]; criteria?: RubricCriterionInput[] }) =>
        saveRubricDraft(tx, { rubricVersionId: draft.id, instructions: "Grade it.", allowedFlags: [], criteria: twoCriteria(role), actor, ...patch });

      await expectRubricError(save({ instructions: "   " }), "instructions_required");
      await expectRubricError(save({ allowedFlags: [{ key: "Bad Key!", label: "Bad" }] }), "invalid_flag_key");
      await expectRubricError(save({ allowedFlags: [{ label: "Hid it" }, { key: "hid_it", label: "Hid it again" }] }), "duplicate_flag");
      await expectRubricError(save({ allowedFlags: [{ key: "empty", label: " " }] }), "flag_label_required");
      for (const weight of [0, -1, 1.005, 1000, Number.NaN]) {
        await expectRubricError(save({ criteria: [criterionInput("Reliability", [role.questions.commitment], { weight })] }), "invalid_weight");
      }
      await expectRubricError(save({ criteria: [criterionInput(" ", [role.questions.commitment])] }), "criterion_name_required");
      await expectRubricError(
        save({ criteria: [criterionInput("Reliability", [role.questions.commitment], { guidanceWeak: "" })] }),
        "guidance_required",
        /weak answer looks like for "Reliability"/,
      );
      await expectRubricError(save({ criteria: [criterionInput("Reliability", [])] }), "questions_required");
      await expectRubricError(
        save({ criteria: [criterionInput("Reliability", [role.questions.commitment]), criterionInput("Reliability", [role.questions.mistake])] }),
        "duplicate_criterion",
      );
      await expectRubricError(save({ criteria: [criterionInput("Odd key", [role.questions.commitment], { key: "Odd Key" })] }), "invalid_criterion_key");

      // Only this role's questions, and never one marked never to send.
      const snow = await loadSnow(tx);
      const [snowQuestion] = await tx.select({ id: question.id }).from(question).where(eq(question.roleId, snow.roleId)).limit(1);
      await expectRubricError(save({ criteria: [criterionInput("Reliability", [snowQuestion!.id])] }), "question_not_found");
      await expectRubricError(save({ criteria: [criterionInput("Reliability", [uuidv7()])] }), "question_not_found");
      await expectRubricError(
        save({ criteria: [criterionInput("Reliability", [role.questions.commitment, role.questions.employer_name])] }),
        "question_never_send",
        /reads employer_name, which is marked never to send to the AI/,
      );

      // Nothing was saved by the refusals.
      expect((await loadRubricVersion(tx, draft.id))!.criteria).toEqual([]);
    });
  });

  it("keeps a criterion's key across versions and marks a change of meaning only on one the published version has", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const first = await publishedRubric(tx, role);
      const published = (await loadRubricVersion(tx, first.id))!;

      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      expect(draft.version).toBe(2);
      // The draft starts as a copy, nothing marked as a change of meaning.
      expect(draft.criteria.map((c) => [c.criterionId, c.weight, c.meaningChanged])).toEqual(published.criteria.map((c) => [c.criterionId, c.weight, false]));

      const [reliability, integrity] = draft.criteria;
      const saved = await saveRubricDraft(tx, {
        rubricVersionId: draft.id,
        instructions: draft.instructions,
        allowedFlags: [],
        criteria: [
          // Renamed with its id: the key stays.
          { ...reliability!, name: "Showing up", meaningChanged: true },
          // Removed and added back by name: the same criterion again.
          criterionInput("Integrity", [role.questions.mistake], { meaningChanged: true }),
          // New: a change of meaning has nothing to compare with.
          criterionInput("Problem solving", [role.questions.equipment], { meaningChanged: true }),
        ],
        actor,
      });
      expect(saved.criteria.map((c) => [c.key, c.name, c.meaningChanged])).toEqual([
        ["reliability", "Showing up", true],
        ["integrity", "Integrity", true],
        ["problem_solving", "Problem solving", false],
      ]);
      expect(saved.criteria[0]!.criterionId).toBe(reliability!.criterionId);
      expect(saved.criteria[1]!.criterionId).toBe(integrity!.criterionId);
      const identities = await tx.select().from(rubricCriterion).where(eq(rubricCriterion.rubricId, draft.rubricId));
      expect(identities.map((c) => c.key).sort()).toEqual(["integrity", "problem_solving", "reliability"]);
    });
  });

  it("discards a draft and leaves the published version alone", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const first = await publishedRubric(tx, role);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      await discardRubricDraft(tx, { rubricVersionId: draft.id, actor });

      expect(await loadRubricVersion(tx, draft.id)).toBeNull();
      expect(await tx.select().from(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, draft.id))).toHaveLength(0);
      expect((await loadRubricVersion(tx, first.id))!.status).toBe("published");
      expect((await audits(tx, draft.id)).map((a) => a.action)).toContain("rubric.draft_discard");
      await expectRubricError(discardRubricDraft(tx, { rubricVersionId: first.id, actor }), "version_not_draft");
    });
  });
});

describe("publishing", () => {
  it("needs a written reason, never a Try it run, and retires the previous version in the same transaction", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const first = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      await saveRubricDraft(tx, { rubricVersionId: first.id, instructions: "Grade it.", allowedFlags: [], criteria: twoCriteria(role), actor });
      await expectRubricError(publishRubricVersion(tx, { rubricVersionId: first.id, changeReason: "  ", actor }), "change_reason_required");

      // No samples exist and none were tried: a reason is all publishing needs.
      const now = new Date("2026-10-30T15:00:00Z");
      const one = await publishRubricVersion(tx, { rubricVersionId: first.id, changeReason: " Owner's first rubric ", actor, now });
      expect(one).toMatchObject({ version: 1, previous: null });
      expect(await tx.select().from(rubricVersion).where(eq(rubricVersion.id, first.id))).toMatchObject([
        { status: "published", changeReason: "Owner's first rubric", publishedBy: adminId, publishedAt: now },
      ]);

      const second = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      const two = await publishRubricVersion(tx, { rubricVersionId: second.id, changeReason: "Same rubric, written again", actor });
      expect(two).toMatchObject({ version: 2, previous: { rubricVersionId: first.id, version: 1 } });
      const statuses = await tx.select({ version: rubricVersion.version, status: rubricVersion.status }).from(rubricVersion).where(eq(rubricVersion.rubricId, first.rubricId));
      expect(statuses.sort((a, b) => a.version - b.version)).toEqual([
        { version: 1, status: "retired" },
        { version: 2, status: "published" },
      ]);

      const [entry] = (await audits(tx, second.id)).filter((a) => a.action === "config.publish");
      expect(entry).toMatchObject({ entityType: "rubric_version", actorUserId: adminId });
      expect(entry!.changes).toMatchObject({
        roleId: role.roleId,
        version: 2,
        previousVersion: 1,
        previousRubricVersionId: first.id,
        changeReason: "Same rubric, written again",
        criteria: [
          { key: "reliability", weight: 2 },
          { key: "integrity", weight: 1 },
        ],
      });
    });
  });

  it("refuses a draft that is not ready, including a question marked never to send after it was saved", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      await expectRubricError(publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason: "Too early", actor }), "criteria_required");

      await saveRubricDraft(tx, { rubricVersionId: draft.id, instructions: "Grade it.", allowedFlags: [], criteria: twoCriteria(role), actor });
      expect(await checkRubricDraft(tx, draft.id)).toEqual([]);
      await tx.update(question).set({ aiNeverSend: true }).where(eq(question.id, role.questions.mistake));
      expect((await checkRubricDraft(tx, draft.id)).map((p) => p.code)).toEqual(["question_never_send"]);
      await expectRubricError(publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason: "Ready", actor }), "question_never_send", /reads mistake/);
      expect((await loadRubricVersion(tx, draft.id))!.status).toBe("draft");
    });
  });

  it("never changes a published version: the service refuses and the database rejects", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const first = await publishedRubric(tx, role);
      const edit = { rubricVersionId: first.id, instructions: "Changed after publishing", allowedFlags: [], criteria: twoCriteria(role), actor };
      await expectRubricError(saveRubricDraft(tx, edit), "version_not_draft", /Rubric version 1 is published and cannot change/);
      await expectRubricError(publishRubricVersion(tx, { rubricVersionId: first.id, changeReason: "Again", actor }), "version_not_draft");
      expect((await loadRubricVersion(tx, first.id))!.instructions).toBe("Grade the behavior.");

      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.update(rubricVersion).set({ instructions: "Sneaky" }).where(eq(rubricVersion.id, first.id));
        }),
        PG.immutablePublished,
      );
      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.update(rubricVersionCriterion).set({ weight: 9 }).where(eq(rubricVersionCriterion.rubricVersionId, first.id));
        }),
        PG.immutablePublished,
      );
    });
  });
});

describe("scoring mode", () => {
  it("turns scoring on only with a published version, and audits each change", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      // No rubric at all: off is a no-op that creates nothing, on is refused.
      expect(await setScoringMode(tx, { roleId: role.roleId, mode: "off", actor })).toEqual({ mode: "off", previous: "off" });
      expect(await tx.select().from(rubric).where(eq(rubric.roleId, role.roleId))).toHaveLength(0);
      await expectRubricError(setScoringMode(tx, { roleId: role.roleId, mode: "hidden", actor }), "mode_needs_published", /Publish a rubric version/);

      // A draft is not enough.
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      await saveRubricDraft(tx, { rubricVersionId: draft.id, instructions: "Grade it.", allowedFlags: [], criteria: twoCriteria(role), actor });
      await expectRubricError(setScoringMode(tx, { roleId: role.roleId, mode: "visible", actor }), "mode_needs_published");

      await publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason: "Ready", actor });
      expect(await setScoringMode(tx, { roleId: role.roleId, mode: "hidden", actor })).toEqual({ mode: "hidden", previous: "off" });
      expect(await setScoringMode(tx, { roleId: role.roleId, mode: "visible", actor })).toEqual({ mode: "visible", previous: "hidden" });
      // The same mode again changes nothing and writes no audit row.
      expect(await setScoringMode(tx, { roleId: role.roleId, mode: "visible", actor })).toEqual({ mode: "visible", previous: "visible" });
      expect(await setScoringMode(tx, { roleId: role.roleId, mode: "off", actor })).toEqual({ mode: "off", previous: "visible" });

      const [row] = await tx.select().from(rubric).where(eq(rubric.roleId, role.roleId));
      const changes = (await audits(tx, row!.id)).filter((a) => a.action === "rubric.mode_change").map((a) => a.changes);
      expect(changes).toEqual([
        { roleId: role.roleId, scoringMode: { from: "off", to: "hidden" } },
        { roleId: role.roleId, scoringMode: { from: "hidden", to: "visible" } },
        { roleId: role.roleId, scoringMode: { from: "visible", to: "off" } },
      ]);
      await expectRubricError(setScoringMode(tx, { roleId: uuidv7(), mode: "off", actor }), "role_not_found");
    });
  });
});

describe("the daily scoring limit", () => {
  it("saves employer.scoring_daily_cap from 1 to 1000, audited, and reports today's use", async () => {
    await withRollback(db, async (tx) => {
      expect(await updateScoringDailyCap(tx, { cap: 250, actor })).toBe(250);
      const cap = await getScoringCap(tx);
      expect(cap.cap).toBe(250);
      expect(cap.usedToday).toBe(await scoringCallsOn(tx, cap.employerId, centralDate(new Date())));
      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "employer.scoring_cap_update"), eq(auditLog.entityId, cap.employerId)));
      expect(entry!.changes).toEqual({ scoringDailyCap: { from: 100, to: 250 } });

      for (const bad of [0, 1001, 2.5, Number.NaN]) {
        await expect(updateScoringDailyCap(tx, { cap: bad, actor })).rejects.toBeInstanceOf(ConfigError);
      }
      const [row] = await tx.select({ cap: employer.scoringDailyCap }).from(employer).where(eq(employer.id, cap.employerId));
      expect(row!.cap).toBe(250);
    });
  });

  it("accepts weights in whole hundredths above 0 up to 999.99", () => {
    expect([0.01, 1, 2.5, 30, 999.99].every(validWeight)).toBe(true);
    expect([0, -1, 0.001, 1.005, 1000, Number.POSITIVE_INFINITY, Number.NaN].some(validWeight)).toBe(false);
  });
});

describe("what Settings > AI scoring shows", () => {
  it("lists the role's questions with their wording, the never-send flag and whether the live form asks them", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const options = await loadRubricQuestions(tx, role.roleId);
      expect(options.map((o) => [o.key, o.aiNeverSend, o.onLiveForm])).toEqual([
        ["commitment", false, true],
        ["employer_name", true, true],
        ["equipment", false, true],
        ["mistake", false, true],
      ]);
      expect(options.find((o) => o.key === "commitment")!.prompt).toMatch(/couldn't make a shift/);
    });
  });

  it("loads the role's published version, open draft and history", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const first = await publishedRubric(tx, role);
      const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor });
      const loaded = (await loadRoleRubric(tx, role.roleId))!;
      expect(loaded.mode).toBe("off");
      expect(loaded.published?.id).toBe(first.id);
      expect(loaded.published?.publishedBy?.id).toBe(adminId);
      expect(loaded.draft?.id).toBe(draft.id);
      expect(loaded.history.map((h) => [h.version, h.status])).toEqual([
        [2, "draft"],
        [1, "published"],
      ]);
      expect(loaded.submittedCount).toBe(0);
      expect(await loadRoleRubric(tx, uuidv7())).toBeNull();
    });
  });

  it("shows hidden mode's recent scores beside the latest human decision", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      const draft = await publishedRubric(tx, role);
      await setScoringMode(tx, { roleId: role.roleId, mode: "hidden", actor });

      const apply = async (lastName: string) => {
        const personId = await createPerson(tx, { firstName: "Casey", lastName });
        const { applicationId } = await createApplication(tx, { personId, openingId: role.openingId, origin: "landing", entryChannel: "role_qr", actor: { type: "applicant" } });
        await transition(tx, { action: "submit", applicationId, actor: { type: "applicant" } });
        return applicationId;
      };
      const declined = await apply("Declined");
      const undecided = await apply("Undecided");
      await createAiScore(tx, { applicationId: declined, rubricVersionId: draft.id, isCurrent: true, overallScore: 34, completedAt: new Date(Date.now() - 60_000) });
      await createAiScore(tx, { applicationId: undecided, rubricVersionId: draft.id, isCurrent: true, status: "failed", overallScore: null });
      // An older decision, then the latest one, which the table shows.
      const reasonId = await loadOption(tx, "disqualify_reason", "availability_conflict");
      await tx.insert(reviewDecision).values([
        { id: uuidv7(), applicationId: declined, decision: "hold", aiScoreVisible: false, decidedBy: adminId, decidedAt: new Date(Date.now() - 30_000) },
        { id: uuidv7(), applicationId: declined, decision: "decline", reasonOptionId: reasonId, aiScoreVisible: false, decidedBy: adminId, decidedAt: new Date() },
      ]);

      const rows = await loadCalibration(tx, role.roleId);
      expect(rows.map((r) => [r.name, r.status, r.overallScore, r.decision?.value ?? null, r.decision?.reason ?? null])).toEqual([
        ["Casey Undecided", "failed", null, null, null],
        ["Casey Declined", "succeeded", 34, "decline", "Availability doesn't fit"],
      ]);
      expect(rows[1]).toMatchObject({ rubricVersion: 1, stage: "Submitted", closed: false });
    });
  });
});
