import { expect, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CHANGES, runChanges } from "../src/db/changes";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { saveAnswer } from "../src/server/services/applications/answers";
import { createApplication, transition } from "../src/server/services/applications/transition";
import { runDueJobs } from "../src/server/services/jobs/run";
import { createSinkProviders } from "../src/server/services/messaging/providers";
import { fakeScorer } from "../src/server/services/scoring/fake";
import { createRubricVersion, ensureRubric } from "../tests/helpers/phase2";

// AI scores on a phone, signed in through the development bypass. Setup publishes a
// snow rubric that reads two of the owner's behavioral questions and turns snow to
// visible mode, submits three applicants whose answers carry the fake scorer's
// markers, and runs the jobs step with the fake scorer. The profile shows the score
// with its grades, and the list sorts by it. Snow scoring is turned off again after.

test.describe("AI scores", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const surname = `Ranked${stamp}`;
  let sql: ReturnType<typeof postgres>;
  let openingId: string;
  let rubricId: string;
  const ids: Record<"ann" | "ben" | "cal", string> = { ann: "", ben: "", cal: "" };

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    // Snow form v2, with the behavioral questions, as `pnpm db:changes` leaves it.
    await runChanges(db, CHANGES);

    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db
      .select({ id: schema.opening.id })
      .from(schema.opening)
      .where(and(eq(schema.opening.roleId, snow!.id), eq(schema.opening.status, "open")));
    openingId = open!.id;
    const [admin] = await db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(and(eq(schema.appUser.role, "admin"), eq(schema.appUser.status, "active")))
      .limit(1);
    const questions = await db
      .select({ key: schema.question.key, questionId: schema.question.id, versionId: schema.questionVersion.id })
      .from(schema.formItem)
      .innerJoin(schema.formVersion, eq(schema.formVersion.id, schema.formItem.formVersionId))
      .innerJoin(schema.questionVersion, eq(schema.questionVersion.id, schema.formItem.questionVersionId))
      .innerJoin(schema.question, eq(schema.question.id, schema.questionVersion.questionId))
      .where(
        and(
          eq(schema.formVersion.roleId, snow!.id),
          eq(schema.formVersion.status, "published"),
          inArray(schema.question.key, ["missed_commitment", "unnoticed_mistake"]),
        ),
      );
    const byKey = Object.fromEntries(questions.map((q) => [q.key, q]));

    rubricId = await ensureRubric(db, snow!.id);
    await createRubricVersion(db, rubricId, {
      published: true,
      publishedBy: admin!.id,
      criteria: [
        { key: "reliability", weight: 2, questionIds: [byKey.missed_commitment!.questionId] },
        { key: "integrity", weight: 1, questionIds: [byKey.unnoticed_mistake!.questionId] },
      ],
    });
    await db.update(schema.rubric).set({ scoringMode: "visible" }).where(eq(schema.rubric.id, rubricId));

    // Submitted oldest first, so newest first lists Cal, Ben, Ann and the score order is Ann, Cal, Ben.
    const applicants = [
      { key: "ann", first: "Ann", commitment: "I called my lead the night before [score:5]", mistake: "I told the owner right away [score:5]" },
      { key: "ben", first: "Ben", commitment: "It never happened [score:1]", mistake: "Nobody noticed [score:1]" },
      { key: "cal", first: "Cal", commitment: "I texted as soon as I knew.", mistake: "I fixed the streak." },
    ] as const;
    const base = Date.now() - 30 * 60_000;
    for (const [i, who] of applicants.entries()) {
      const personId = uuidv7();
      const email = `scoring-${who.first.toLowerCase()}-${stamp}@example.test`;
      await db.insert(schema.person).values({
        id: personId,
        firstName: who.first,
        lastName: surname,
        mobileE164: `+1651${2_000_000 + Math.floor(Math.random() * 7_000_000)}`,
        email,
        emailNormalized: email,
      });
      const { applicationId } = await createApplication(db, {
        personId,
        openingId,
        origin: "landing",
        entryChannel: "role_qr",
        actor: { type: "applicant" },
        occurredAt: new Date(base + i * 60_000),
      });
      await saveAnswer(db, { applicationId, questionVersionId: byKey.missed_commitment!.versionId, revision: 0, value: who.commitment });
      await saveAnswer(db, { applicationId, questionVersionId: byKey.unnoticed_mistake!.versionId, revision: 0, value: who.mistake });
      await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, occurredAt: new Date(base + (10 + i) * 60_000) });
      ids[who.key] = applicationId;
    }
    await runDueJobs(db, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer });
  });

  test.afterAll(async () => {
    if (!sql) return;
    if (rubricId) await sql`update rubric set scoring_mode = 'off' where id = ${rubricId}`;
    const created = Object.values(ids).filter(Boolean);
    if (created.length > 0) await sql`update application set deleted_at = now() where id in ${sql(created)}`;
    await sql.end();
  });

  test("the profile shows the score, each criterion's grade and the sorting-aid line, and an Admin can re-score", async ({ page }) => {
    await page.goto(`/admin/applicants/${ids.ann}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Ann ${surname}`);
    await expect(page.getByText("AI score", { exact: true })).toBeVisible();
    await expect(page.getByText("100", { exact: true })).toBeVisible();
    await expect(page.getByText("out of 100")).toBeVisible();
    await expect(page.getByText("5 of 5")).toHaveCount(2);
    await expect(page.getByText("A sorting aid only. It never moves, rejects or messages anyone.")).toBeVisible();
    await expect(page.getByText(/^Rubric v\d+, scored /)).toBeVisible();

    await page.getByRole("button", { name: "Re-score", exact: true }).click();
    await expect(page.getByRole("button", { name: "Re-score queued" })).toBeDisabled();
    await expect(page.getByText("A new score is on its way.")).toBeVisible();
  });

  test("the list shows each score and sorts by it", async ({ page }) => {
    await page.goto(`/admin?opening=${openingId}&q=${surname}`);
    const rowNames = page.locator('ul a[href^="/admin/applicants/"]');
    await expect(rowNames).toHaveText([`Cal ${surname}`, `Ben ${surname}`, `Ann ${surname}`]);
    await expect(page.getByText("AI score 100")).toBeVisible();
    await expect(page.getByText("AI score 51")).toBeVisible();
    await expect(page.getByText("AI score 1", { exact: true })).toBeVisible();

    await page.getByLabel("Sort").selectOption("ai_score");
    await expect(page).toHaveURL(/sort=ai_score/);
    await expect(rowNames).toHaveText([`Ann ${surname}`, `Cal ${surname}`, `Ben ${surname}`]);
    await expect(page.getByText("Sorted by AI score, highest first")).toBeVisible();
  });
});
