import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiScore, application, reviewDecision, rubric } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { moveBoardCard } from "@/server/services/applications/board";
import { undoLastChange } from "@/server/services/applications/corrections";
import { transition, type TransitionInput } from "@/server/services/applications/transition";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadOption, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createAiScore } from "./helpers/phase2";
import { createScoringRole, submitScoringApplication, type ScoringRoleFixture } from "./helpers/scoring";

// The screening decision written inside transition() (scoring/after-transition.ts;
// DATA_MODEL.md, review_decision, "Rule"): one case per branch. Each case runs on a role
// of its own inside a rolled-back transaction.

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScoreValues = Partial<typeof aiScore.$inferInsert>;

// A submitted application with a current score (succeeded and shown, unless values say otherwise).
async function scored(tx: Tx, role: ScoringRoleFixture, values: ScoreValues = {}) {
  const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
  const aiScoreId = await createAiScore(tx, {
    applicationId,
    rubricVersionId: role.published.rubricVersionId,
    isCurrent: true,
    hiddenFromReviewers: false,
    ...values,
  });
  return { applicationId, aiScoreId };
}

async function act(tx: Tx, applicationId: string, input: Record<string, unknown>) {
  const [app] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, applicationId));
  return transition(tx, { applicationId, actor: staffActor(adminId), expectedSeq: app!.eventSeq, ...input } as TransitionInput);
}

async function decisions(tx: Tx, applicationId: string) {
  return tx.select().from(reviewDecision).where(eq(reviewDecision.applicationId, applicationId)).orderBy(asc(reviewDecision.createdAt), asc(reviewDecision.id));
}

describe("review decisions", () => {
  it("writes decline with the same reason when staff disqualify, linked to the event and the visible score", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      const { applicationId, aiScoreId } = await scored(tx, role);
      const reasonOptionId = await loadOption(tx, "disqualify_reason", "availability_conflict");
      const result = await act(tx, applicationId, { action: "close", outcome: "disqualified", reasonOptionId, note: "Only free on weekends" });
      expect(await decisions(tx, applicationId)).toEqual([
        expect.objectContaining({
          decision: "decline",
          reasonOptionId,
          note: "Only free on weekends",
          aiScoreId,
          aiScoreVisible: true,
          applicationEventId: result.event.id,
          decidedBy: adminId,
          decidedAt: result.event.occurredAt,
        }),
      ]);
    });
  });

  it("writes advance for a move to a stage at or after interview_invited", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId, aiScoreId } = await scored(tx, role);
      const result = await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });
      expect(await decisions(tx, applicationId)).toEqual([
        expect.objectContaining({ decision: "advance", reasonOptionId: null, aiScoreId, applicationEventId: result.event.id, decidedBy: adminId }),
      ]);
    });
  });

  it("writes advance for Hire now from Submitted and for a board drag into an interview stage", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const hired = await scored(tx, role);
      await act(tx, hired.applicationId, { action: "move", toStageId: role.stages.hired });
      expect(await decisions(tx, hired.applicationId)).toMatchObject([{ decision: "advance", aiScoreId: hired.aiScoreId }]);

      const dragged = await scored(tx, role);
      const [app] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, dragged.applicationId));
      await moveBoardCard(tx, { applicationId: dragged.applicationId, expectedSeq: app!.eventSeq, toStageId: role.stages.one_on_one_invited!, actor: staffActor(adminId) });
      expect(await decisions(tx, dragged.applicationId)).toMatchObject([{ decision: "advance", aiScoreId: dragged.aiScoreId }]);
    });
  });

  it("writes hold when staff put the application on hold, and a later screening action is a new row", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      await act(tx, applicationId, { action: "hold" });
      await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });
      expect((await decisions(tx, applicationId)).map((d) => d.decision)).toEqual(["hold", "advance"]);
    });
  });

  it("writes advance for a reopen straight into an interview stage", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      const reasonOptionId = await loadOption(tx, "withdraw_reason", "took_another_job");
      await act(tx, applicationId, { action: "close", outcome: "withdrew", reasonOptionId });
      await act(tx, applicationId, { action: "reopen", toStageId: role.stages.one_on_one_invited });
      expect((await decisions(tx, applicationId)).map((d) => d.decision)).toEqual(["advance"]);
    });
  });

  it("writes nothing for a move into Reviewed or a withdrew or not_selected closure", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const reviewed = await scored(tx, role);
      await act(tx, reviewed.applicationId, { action: "move", toStageId: role.stages.reviewed });
      await act(tx, reviewed.applicationId, { action: "contacted" });
      const withdrew = await scored(tx, role);
      await act(tx, withdrew.applicationId, { action: "close", outcome: "withdrew", reasonOptionId: await loadOption(tx, "withdraw_reason", "pay") });
      const notSelected = await scored(tx, role);
      await act(tx, notSelected.applicationId, { action: "close", outcome: "not_selected", reasonOptionId: await loadOption(tx, "not_selected_reason", "roles_filled") });
      for (const { applicationId } of [reviewed, withdrew, notSelected]) expect(await decisions(tx, applicationId)).toEqual([]);
    });
  });

  it("writes nothing once interview_invited has been reached, even after moving back", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });
      await act(tx, applicationId, { action: "move", toStageId: role.stages.reviewed });
      await act(tx, applicationId, { action: "hold" });
      await act(tx, applicationId, { action: "unhold" });
      // A disqualification after the interview is not the reviewer overruling the score.
      await act(tx, applicationId, {
        action: "close",
        outcome: "disqualified",
        reasonOptionId: await loadOption(tx, "disqualify_reason", "interview_concerns"),
        note: "Did not show up to the one-on-one",
      });
      expect((await decisions(tx, applicationId)).map((d) => d.decision)).toEqual(["advance"]);
    });
  });

  it("does not count a move into interview that was undone as reaching it", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      const moved = await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });
      await undoLastChange(tx, { applicationId, actor: staffActor(adminId), expectedSeq: moved.application.eventSeq, eventId: moved.event.id });
      await act(tx, applicationId, { action: "hold" });
      expect((await decisions(tx, applicationId)).map((d) => d.decision)).toEqual(["advance", "hold"]);
    });
  });

  it("writes nothing for an application without a current score", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
      // An earlier score that is no longer current does not count either.
      await createAiScore(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, isCurrent: false });
      await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });
      expect(await decisions(tx, applicationId)).toEqual([]);
    });
  });

  it("records whether the reviewer could see the score", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "hidden" });
      const hiddenMode = await scored(tx, role, { hiddenFromReviewers: true });
      await act(tx, hiddenMode.applicationId, { action: "hold" });

      await tx.update(rubric).set({ scoringMode: "visible" }).where(eq(rubric.id, role.rubricId));
      // Scored while hidden, so still not shown after the switch to visible.
      const scoredWhileHidden = await scored(tx, role, { hiddenFromReviewers: true });
      await act(tx, scoredWhileHidden.applicationId, { action: "hold" });
      // A failed score shows as "not scored": there was no number to see.
      const failed = await scored(tx, role, { status: "failed", error: "refusal" });
      await act(tx, failed.applicationId, { action: "hold" });
      const shown = await scored(tx, role);
      await act(tx, shown.applicationId, { action: "hold" });

      const visible = async (applicationId: string) => (await decisions(tx, applicationId)).map((d) => d.aiScoreVisible);
      expect(await visible(hiddenMode.applicationId)).toEqual([false]);
      expect(await visible(scoredWhileHidden.applicationId)).toEqual([false]);
      expect(await visible(failed.applicationId)).toEqual([false]);
      expect(await visible(shown.applicationId)).toEqual([true]);
      const [failedDecision] = await decisions(tx, failed.applicationId);
      expect(failedDecision!.aiScoreId).toBe(failed.aiScoreId);
    });
  });

  it("writes nothing for the applicant's own submit or a system action", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      const [app] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, applicationId));
      await transition(tx, { action: "move", applicationId, toStageId: role.stages.one_on_one_invited!, actor: { type: "system" }, expectedSeq: app!.eventSeq });
      expect(await decisions(tx, applicationId)).toEqual([]);
      // The submit before it wrote none either, and the score stays as it was.
      const [current] = await tx.select().from(aiScore).where(and(eq(aiScore.applicationId, applicationId), eq(aiScore.isCurrent, true)));
      expect(current).toBeDefined();
    });
  });
});
