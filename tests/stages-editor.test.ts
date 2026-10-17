import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, pipelineStage } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { transition } from "@/server/services/applications/transition";
import {
  addStage,
  archiveStage,
  listStages,
  listStagesForEditor,
  milestoneOrderProblem,
  moveStage,
  StageError,
  unarchiveStage,
  updateStage,
} from "@/server/services/config/stages";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { newApplication } from "./helpers/interviews";

let snow: SnowFixture;
let stages: Record<string, string>;
let actor: ReturnType<typeof staffActor>;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  actor = staffActor(await loadAdminId(db));
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function expectStageError(run: Promise<unknown>, code: StageError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof StageError && error.code === code);
}

async function liveKeys(tx: Tx) {
  return (await listStages(tx, snow.roleId)).map((s) => s.key);
}

async function stageAudits(tx: Tx, stageId: string) {
  return tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "pipeline_stage"), eq(auditLog.entityId, stageId)))
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.id));
}

function phoneScreen(tx: Tx, overrides: Partial<Parameters<typeof addStage>[1]> = {}) {
  return addStage(tx, {
    actor,
    roleId: snow.roleId,
    name: "Phone screen",
    publicLabel: "Under review",
    milestone: null,
    showOnBoard: true,
    afterStageId: stages.reviewed!,
    ...overrides,
  });
}

async function moveInto(tx: Tx, stageId: string) {
  const { applicationId } = await newApplication(tx, snow);
  await transition(tx, { action: "move", applicationId, actor, toStageId: stageId });
  return applicationId;
}

describe("milestone order", () => {
  it("lets custom stages sit anywhere and several stages share a milestone, but never steps back", () => {
    const at = (name: string, milestone: "reviewed" | "interviewed" | "hired" | null, sortOrder: number, archived = false) => ({
      id: name,
      name,
      milestone,
      sortOrder,
      archivedAt: archived ? new Date() : null,
    });
    expect(milestoneOrderProblem([at("a", "reviewed", 10), at("b", null, 20), at("c", "reviewed", 30), at("d", "hired", 40)])).toBeNull();
    expect(milestoneOrderProblem([at("a", "interviewed", 10), at("b", "reviewed", 20)])).toMatchObject({ stage: { name: "b" }, above: { name: "a" } });
    // An archived stage is out of the pipeline, so it never blocks.
    expect(milestoneOrderProblem([at("a", "interviewed", 10, true), at("b", "reviewed", 20)])).toBeNull();
  });
});

describe("the stage editor", () => {
  it("adds a custom stage after the chosen one, with a key made from its name, audited", async () => {
    await withRollback(db, async (tx) => {
      const added = await phoneScreen(tx);
      expect(added).toMatchObject({ key: "phone_screen", name: "Phone screen", publicLabel: "Under review", milestone: null, isSystem: false, showOnBoard: true });
      const keys = await liveKeys(tx);
      expect(keys.slice(keys.indexOf("reviewed"), keys.indexOf("reviewed") + 3)).toEqual(["reviewed", "phone_screen", "one_on_one_invited"]);
      // A second stage with the same name is refused; a different one gets its own key.
      await expectStageError(phoneScreen(tx, { name: "phone SCREEN" }), "name_taken");
      const second = await phoneScreen(tx, { name: "Phone screen!", afterStageId: added.id });
      expect(second.key).toBe("phone_screen_2");
      expect(await liveKeys(tx)).toContain("phone_screen_2");

      const [entry] = await stageAudits(tx, added.id);
      expect(entry).toMatchObject({ action: "pipeline_stage.add", actorUserId: actor.type === "staff" ? actor.userId : null });
      expect(entry!.changes).toMatchObject({ key: { to: "phone_screen" }, milestone: { to: null }, afterStageId: stages.reviewed });
    });
  });

  it("renumbers when there is no room between two stages", async () => {
    await withRollback(db, async (tx) => {
      // Five stages in the gap between Reviewed (30) and One-on-one invited (40) leave no room for the next.
      let after = stages.reviewed!;
      for (const name of ["Call one", "Call two", "Call three", "Call four", "Call five"]) {
        after = (await phoneScreen(tx, { name, afterStageId: after })).id;
      }
      const keys = await liveKeys(tx);
      expect(keys.slice(keys.indexOf("reviewed"), keys.indexOf("one_on_one_invited") + 1)).toEqual([
        "reviewed",
        "call_one",
        "call_two",
        "call_three",
        "call_four",
        "call_five",
        "one_on_one_invited",
      ]);
      const sortOrders = (await listStages(tx, snow.roleId)).map((s) => s.sortOrder);
      expect(new Set(sortOrders).size).toBe(sortOrders.length);
    });
  });

  it("renames a stage, edits what applicants see and toggles the board, audited", async () => {
    await withRollback(db, async (tx) => {
      const after = await updateStage(tx, {
        actor,
        stageId: stages.reviewed!,
        patch: { name: "Looked at", publicLabel: "We are reviewing it", showOnBoard: false },
      });
      expect(after).toMatchObject({ key: "reviewed", name: "Looked at", publicLabel: "We are reviewing it", showOnBoard: false, milestone: "reviewed" });
      const [entry] = await stageAudits(tx, stages.reviewed!);
      expect(entry!.action).toBe("pipeline_stage.update");
      expect(entry!.changes).toEqual({
        name: { from: "Reviewed", to: "Looked at" },
        publicLabel: { from: "Under review", to: "We are reviewing it" },
        showOnBoard: { from: true, to: false },
      });
      // A system stage can be renamed too: reports go by its milestone.
      await updateStage(tx, { actor, stageId: stages.submitted!, patch: { name: "New" } });
      await expectStageError(updateStage(tx, { actor, stageId: stages.submitted!, patch: { name: "  " } }), "invalid_input");
      await expectStageError(updateStage(tx, { actor, stageId: stages.submitted!, patch: { publicLabel: "" } }), "invalid_input");
      await expectStageError(updateStage(tx, { actor, stageId: stages.submitted!, patch: { name: "Looked at" } }), "name_taken");
    });
  });

  it("reorders with up and down, keeping milestones in order", async () => {
    await withRollback(db, async (tx) => {
      const added = await phoneScreen(tx);
      await moveStage(tx, { actor, stageId: added.id, direction: "down" });
      let keys = await liveKeys(tx);
      expect(keys.indexOf("phone_screen")).toBe(keys.indexOf("one_on_one_invited") + 1);
      await moveStage(tx, { actor, stageId: added.id, direction: "up" });
      await moveStage(tx, { actor, stageId: added.id, direction: "up" });
      keys = await liveKeys(tx);
      expect(keys.slice(0, 4)).toEqual(["started", "submitted", "phone_screen", "reviewed"]);
      expect((await stageAudits(tx, added.id)).filter((e) => e.action === "pipeline_stage.move")).toHaveLength(3);

      // One-on-one done (interviewed) cannot go above One-on-one invited (interview invited).
      await expectStageError(moveStage(tx, { actor, stageId: stages.one_on_one_done!, direction: "up" }), "milestone_order");
      // The last stage going down, or the first going up, changes nothing.
      await moveStage(tx, { actor, stageId: stages.hired!, direction: "down" });
      expect((await liveKeys(tx)).at(-1)).toBe("hired");
    });
  });
});

describe("lock rules", () => {
  it("never archives, moves or remaps Started and Submitted, and keeps every stage below them", async () => {
    await withRollback(db, async (tx) => {
      for (const key of ["started", "submitted"]) {
        await expectStageError(archiveStage(tx, { actor, stageId: stages[key]! }), "system_stage_locked");
        await expectStageError(moveStage(tx, { actor, stageId: stages[key]!, direction: "down" }), "system_stage_locked");
        await expectStageError(updateStage(tx, { actor, stageId: stages[key]!, patch: { milestone: "reviewed" } }), "system_stage_locked");
      }
      // Moving Reviewed up would move Submitted down.
      await expectStageError(moveStage(tx, { actor, stageId: stages.reviewed!, direction: "up" }), "system_stage_locked");
      // A new stage goes after Submitted at the earliest, and never takes a system milestone.
      await expectStageError(phoneScreen(tx, { afterStageId: stages.started! }), "system_stage_locked");
      await expectStageError(phoneScreen(tx, { milestone: "submitted" }), "milestone_reserved");
      const added = await phoneScreen(tx);
      await expectStageError(updateStage(tx, { actor, stageId: added.id, patch: { milestone: "started" } }), "milestone_reserved");
      expect((await liveKeys(tx)).slice(0, 2)).toEqual(["started", "submitted"]);
    });
  });

  it("fixes a stage's milestone once any event names it; archive and replace instead", async () => {
    await withRollback(db, async (tx) => {
      const added = await phoneScreen(tx);
      // Nothing has used it yet, so its milestone can still change.
      const counted = await updateStage(tx, { actor, stageId: added.id, patch: { milestone: "reviewed" } });
      expect(counted.milestone).toBe("reviewed");
      await updateStage(tx, { actor, stageId: added.id, patch: { milestone: null } });

      await moveInto(tx, added.id);
      const editor = await listStagesForEditor(tx, snow.roleId);
      expect(editor.find((s) => s.id === added.id)).toMatchObject({ inUse: true, openCount: 1 });
      await expectStageError(updateStage(tx, { actor, stageId: added.id, patch: { milestone: "reviewed" } }), "milestone_locked");
      // Its name and label still change.
      await updateStage(tx, { actor, stageId: added.id, patch: { name: "Quick call", publicLabel: "Under review" } });
      const [row] = await tx.select().from(pipelineStage).where(eq(pipelineStage.id, added.id));
      expect(row).toMatchObject({ key: "phone_screen", name: "Quick call", milestone: null });
    });
  });

  it("never lets milestones go backward along the pipeline", async () => {
    await withRollback(db, async (tx) => {
      // A stage counted as Reviewed cannot come after Hired.
      await expectStageError(phoneScreen(tx, { milestone: "reviewed", afterStageId: stages.hired! }), "milestone_order");
      // A custom stage after One-on-one done cannot be remapped to Reviewed.
      const late = await phoneScreen(tx, { name: "Ride along", afterStageId: stages.one_on_one_done! });
      await expectStageError(updateStage(tx, { actor, stageId: late.id, patch: { milestone: "reviewed" } }), "milestone_order");
      await updateStage(tx, { actor, stageId: late.id, patch: { milestone: "interviewed" } });

      // Unarchiving puts a stage back where it was only if its milestone still fits there.
      const early = await phoneScreen(tx, { name: "Second look", milestone: "reviewed" });
      await archiveStage(tx, { actor, stageId: early.id });
      const between = await phoneScreen(tx, { name: "Booked call" });
      await updateStage(tx, { actor, stageId: between.id, patch: { milestone: "interview_invited" } });
      await expectStageError(unarchiveStage(tx, { actor, stageId: early.id }), "milestone_order");
      await updateStage(tx, { actor, stageId: between.id, patch: { milestone: null } });
      const back = await unarchiveStage(tx, { actor, stageId: early.id });
      expect(back.archivedAt).toBeNull();
    });
  });

  it("refuses to archive a stage holding open applications, with the count", async () => {
    await withRollback(db, async (tx) => {
      const added = await phoneScreen(tx);
      const first = await moveInto(tx, added.id);
      const second = await moveInto(tx, added.id);
      await expect(archiveStage(tx, { actor, stageId: added.id })).rejects.toMatchObject({
        code: "stage_has_open_applications",
        message: "2 open applications are in this stage. Move them to another stage first.",
        details: { openCount: 2 },
      });
      const reason = await loadOption(tx, "withdraw_reason", "took_another_job");
      await transition(tx, { action: "close", applicationId: first, actor, outcome: "withdrew", reasonOptionId: reason });
      await expect(archiveStage(tx, { actor, stageId: added.id })).rejects.toMatchObject({
        message: "1 open application is in this stage. Move it to another stage first.",
      });
      await transition(tx, { action: "move", applicationId: second, actor, toStageId: stages.reviewed! });

      const archived = await archiveStage(tx, { actor, stageId: added.id });
      expect(archived.archivedAt).not.toBeNull();
      expect(await liveKeys(tx)).not.toContain("phone_screen");
      // The closed application still points at it, and the editor still lists it.
      expect((await listStagesForEditor(tx, snow.roleId)).find((s) => s.id === added.id)).toMatchObject({ inUse: true, openCount: 0 });
      await expectStageError(moveStage(tx, { actor, stageId: added.id, direction: "up" }), "stage_archived");

      await unarchiveStage(tx, { actor, stageId: added.id });
      expect(await liveKeys(tx)).toContain("phone_screen");
      expect((await stageAudits(tx, added.id)).map((e) => e.action)).toEqual(["pipeline_stage.add", "pipeline_stage.archive", "pipeline_stage.unarchive"]);
    });
  });

  it("keeps a live Hired stage for Hire now and the hire form", async () => {
    await withRollback(db, async (tx) => {
      await expectStageError(archiveStage(tx, { actor, stageId: stages.hired! }), "last_hired_stage");
      const another = await phoneScreen(tx, { name: "Hired for spring", publicLabel: "Hired", milestone: "hired", afterStageId: stages.hired! });
      await archiveStage(tx, { actor, stageId: stages.hired! });
      await expectStageError(archiveStage(tx, { actor, stageId: another.id }), "last_hired_stage");
      await expectStageError(updateStage(tx, { actor, stageId: another.id, patch: { milestone: "background_check" } }), "last_hired_stage");
    });
  });
});
