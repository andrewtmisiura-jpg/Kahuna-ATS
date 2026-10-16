import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiScore, rubric } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { boardFilterParams, loadBoard, parseBoardFilters } from "@/server/services/applications/board";
import {
  listApplicationIds,
  listApplications,
  listFilterOptions,
  listFilterParams,
  listOpenings,
  parseListFilters,
  type ListFilters,
} from "@/server/services/applications/queries";
import { runDueJobs } from "@/server/services/jobs/run";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { fakeScorer } from "@/server/services/scoring/fake";
import { requestRescore } from "@/server/services/scoring/jobs";
import { loadScoringPanel } from "@/server/services/scoring/panel";
import type { Scorer } from "@/server/services/scoring/types";
import { withRollback } from "./helpers/db";
import { loadAdminId, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { createScoringRole, submitScoringApplication, type ScoringRoleFixture } from "./helpers/scoring";

// Where staff see the score (visible mode only): the badge and the "AI score, high to
// low" sort on the list and the board, and what the profile's panel is given. Each case
// runs on a role of its own inside a rolled-back transaction.

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Five applicants submitted a second apart, oldest first: top scores 100, low 1, middle
// and tied both 51 (tied submitted later), and unscored has no answer to one criterion.
async function scoredApplicants(tx: Tx, role: ScoringRoleFixture) {
  const start = Date.now() - 60_000;
  const submit = async (lastName: string, answers: Record<string, string>, i: number) =>
    (await submitScoringApplication(tx, role, answers, { firstName: "Rank", lastName }, new Date(start + i * 1_000))).applicationId;
  const ids = {
    top: await submit("Top", { commitment: "[score:5]", mistake: "[score:5]" }, 0),
    low: await submit("Low", { commitment: "[score:1]", mistake: "[score:1]" }, 1),
    middle: await submit("Middle", { commitment: "Called ahead.", mistake: "Told them." }, 2),
    unscored: await submit("Unscored", { commitment: "Called ahead." }, 3),
    tied: await submit("Tied", { commitment: "Called ahead.", mistake: "Told them." }, 4),
  };
  await runDueJobs(tx, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer });
  return ids;
}

function names(rows: { lastName: string }[]) {
  return rows.map((row) => row.lastName);
}

describe("the list", () => {
  it("shows each row's score and sorts by it, unscored last and ties newest first, keeping newest first as the default", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      const ids = await scoredApplicants(tx, role);
      const filters: ListFilters = { openingId: role.openingId };

      const byDefault = await listApplications(tx, filters, "admin");
      expect(names(byDefault.rows)).toEqual(["Tied", "Unscored", "Middle", "Low", "Top"]);
      expect(Object.fromEntries(byDefault.rows.map((row) => [row.lastName, row.aiScore]))).toEqual({ Top: 100, Low: 1, Middle: 51, Tied: 51, Unscored: null });

      const sorted = await listApplications(tx, { ...filters, sort: "ai_score" }, "admin");
      expect(names(sorted.rows)).toEqual(["Top", "Tied", "Middle", "Low", "Unscored"]);
      // Previous and Next on the profile walk the same order.
      expect(await listApplicationIds(tx, { ...filters, sort: "ai_score" }, "admin")).toEqual([ids.top, ids.tied, ids.middle, ids.low, ids.unscored]);
      // Viewers see the scores too.
      expect(names((await listApplications(tx, { ...filters, sort: "ai_score" }, "viewer")).rows)).toEqual(["Top", "Tied", "Middle", "Low", "Unscored"]);
      expect((await listApplications(tx, filters, "viewer")).rows.find((row) => row.lastName === "Top")!.aiScore).toBe(100);

      const opening = (await listOpenings(tx)).find((o) => o.id === role.openingId)!;
      expect((await listFilterOptions(tx, opening)).aiScoreSort).toBe(true);
    });
  });

  it("shows no score and offers no sort while the role is hidden or off, and never a score made while hidden", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      await scoredApplicants(tx, role);
      const opening = (await listOpenings(tx)).find((o) => o.id === role.openingId)!;
      const filters: ListFilters = { openingId: role.openingId, sort: "ai_score" };

      for (const mode of ["hidden", "off"] as const) {
        await tx.update(rubric).set({ scoringMode: mode }).where(eq(rubric.id, role.rubricId));
        const rows = (await listApplications(tx, filters, "admin")).rows;
        expect(rows.every((row) => row.aiScore === null)).toBe(true);
        // A sort left in the URL falls back to newest first.
        expect(names(rows)).toEqual(["Tied", "Unscored", "Middle", "Low", "Top"]);
        expect((await listFilterOptions(tx, opening)).aiScoreSort).toBe(false);
      }

      // Back to visible: a score made while hidden stays out of sight.
      await tx.update(rubric).set({ scoringMode: "visible" }).where(eq(rubric.id, role.rubricId));
      const top = (await listApplications(tx, filters, "admin")).rows.find((row) => row.lastName === "Top")!;
      await tx.update(aiScore).set({ isCurrent: false }).where(eq(aiScore.applicationId, top.id));
      await tx.update(rubric).set({ scoringMode: "hidden" }).where(eq(rubric.id, role.rubricId));
      await requestRescore(tx, { applicationId: top.id, actorUserId: adminId });
      await runDueJobs(tx, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer });
      await tx.update(rubric).set({ scoringMode: "visible" }).where(eq(rubric.id, role.rubricId));
      expect((await listApplications(tx, filters, "admin")).rows.find((row) => row.lastName === "Top")!.aiScore).toBeNull();
    });
  });

  it("reads and writes the sort in the URL", () => {
    const opening = "00000000-0000-7000-8000-000000000001";
    expect(parseListFilters({ sort: "ai_score" }, opening).sort).toBe("ai_score");
    expect(parseListFilters({ sort: "name" }, opening).sort).toBeUndefined();
    expect(listFilterParams({ openingId: opening, sort: "ai_score" }).get("sort")).toBe("ai_score");
    expect(listFilterParams({ openingId: opening }).has("sort")).toBe(false);
    expect(parseBoardFilters({ sort: "ai_score" }, opening).sort).toBe("ai_score");
    expect(boardFilterParams({ openingId: opening, sort: "ai_score" }).get("sort")).toBe("ai_score");
  });
});

describe("the board", () => {
  it("puts the score on each card and sorts a column by it, unscored last and ties by submitted date", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      await scoredApplicants(tx, role);
      const column = async (sort?: "ai_score") => {
        const board = await loadBoard(tx, { openingId: role.openingId, sort }, "admin");
        return board.columns.find((c) => c.stage.key === "submitted")!.cards;
      };
      const byDefault = await column();
      expect(byDefault.map((card) => card.lastName)).toEqual(["Top", "Low", "Middle", "Unscored", "Tied"]);
      expect(byDefault.map((card) => card.aiScore)).toEqual([100, 1, 51, null, 51]);
      expect((await column("ai_score")).map((card) => card.lastName)).toEqual(["Top", "Middle", "Tied", "Low", "Unscored"]);
    });
  });
});

describe("the profile panel", () => {
  it("gives the score with each criterion's grade and rationale, the flags by label, keyword hits and the rubric version", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead [score:5] [flag:no_answer]", mistake: "Told them." });
      const mentions: Scorer = {
        async score(r, input) {
          const result = await fakeScorer.score(r, input);
          return result.status === "succeeded" ? { ...result, overallRationale: "Owns it; mentions family." } : result;
        },
      };
      expect(await loadScoringPanel(tx, applicationId)).toMatchObject({ current: null, pending: true, missingAnswers: false });
      await runDueJobs(tx, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: mentions });
      const panel = await loadScoringPanel(tx, applicationId);
      expect(panel).toMatchObject({
        publishedVersion: role.published.version,
        pending: false,
        missingAnswers: false,
        readsNeverSend: false,
        current: {
          status: "succeeded",
          overallScore: 84,
          hiddenFromReviewers: false,
          rationale: "Owns it; mentions family.",
          flags: [{ key: "no_answer", label: "Did not answer the question" }],
          keywordHits: ["family"],
          rubricVersion: role.published.version,
          criteria: [
            { key: "reliability", name: "reliability", score: 5 },
            { key: "integrity", name: "integrity", score: 3 },
          ],
        },
      });
      expect(panel!.current!.completedAt).toBeInstanceOf(Date);
      expect(panel!.current!.criteria[0]!.rationale).toMatch(/^Fake scorer/);
    });
  });

  it("says why there is no number: missing answers, a failed call, or nothing outside visible mode", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId, mode: "visible" });
      const missing = await submitScoringApplication(tx, role, { commitment: "Called ahead." });
      const failed = await submitScoringApplication(tx, role, { commitment: "[fail]", mistake: "Told them." });
      await runDueJobs(tx, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer });
      expect(await loadScoringPanel(tx, missing.applicationId)).toMatchObject({ current: null, pending: false, missingAnswers: true });
      expect(await loadScoringPanel(tx, failed.applicationId)).toMatchObject({ current: { status: "failed", overallScore: null, criteria: [] }, missingAnswers: false });

      await tx.update(rubric).set({ scoringMode: "hidden" }).where(eq(rubric.id, role.rubricId));
      expect(await loadScoringPanel(tx, failed.applicationId)).toBeNull();
    });
  });
});
