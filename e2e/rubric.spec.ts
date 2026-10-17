import { expect, test } from "@playwright/test";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CHANGES, runChanges } from "../src/db/changes";
import { SNOW_STARTER_TEST_CASES } from "../src/db/changes/snow-starter-rubric";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { staffActor } from "../src/server/services/actor";
import { addTestCase, listTestCases } from "../src/server/services/scoring/test-cases";

// Settings > AI scoring on a phone, signed in through the development bypass. Setup runs
// the one-time changes, so snow has the starter rubric, published and visible, with its
// Try it samples (added here too when another spec made the snow rubric first). An Admin
// then edits a weight in a draft, runs Try it with the stand-in scorer and publishes the
// draft with a written reason.

test.describe("AI scoring rubric", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const snowName = "Snow Removal Technician (on-call)";
  let sql: ReturnType<typeof postgres>;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    await runChanges(db, CHANGES);

    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [rubric] = await db.select({ id: schema.rubric.id }).from(schema.rubric).where(eq(schema.rubric.roleId, snow!.id));
    if ((await listTestCases(db, rubric!.id)).length === 0) {
      const [admin] = await db
        .select({ id: schema.appUser.id })
        .from(schema.appUser)
        .where(and(eq(schema.appUser.role, "admin"), eq(schema.appUser.status, "active")))
        .orderBy(asc(schema.appUser.createdAt))
        .limit(1);
      for (const sample of SNOW_STARTER_TEST_CASES) await addTestCase(db, { rubricId: rubric!.id, ...sample, actor: staffActor(admin!.id) });
    }
  });

  test.afterAll(async () => {
    await sql?.end();
  });

  test("an Admin sees snow published and visible, edits a weight in a draft, tries it and publishes with a reason", async ({ page }) => {
    await page.goto("/admin/settings/scoring");
    await expect(page.getByRole("heading", { level: 1, name: "AI scoring" })).toBeVisible();
    await expect(page.getByText("AI notice on the landing page")).toBeVisible();

    const card = page.getByRole("region", { name: snowName });
    const visible = card.getByRole("radio", { name: /^Visible/ });
    // Snow may have been left with scoring off by hand or by an earlier run; the screen turns it back on.
    if (!(await visible.isChecked())) await visible.check();
    await expect(card.getByText("Scoring visible")).toBeVisible();
    await expect(visible).toBeChecked();
    await expect(card.getByRole("heading", { name: /^Published version \d+$/ })).toBeVisible();
    await expect(card.getByText("Reads missed_commitment")).toBeVisible();

    await card.getByRole("link", { name: "Edit rubric" }).click();
    await expect(page.getByRole("heading", { level: 1, name: snowName })).toBeVisible();
    const start = page.getByRole("button", { name: /^Start a draft from version \d+$/ });
    const save = page.getByRole("button", { name: "Save draft" });
    await expect(start.or(save)).toBeVisible();
    if (await start.isVisible()) await start.click();
    await expect(save).toBeVisible();

    const draftTitle = await page.getByText(/^Draft version \d+$/).textContent();
    const version = /\d+/.exec(draftTitle ?? "")![0];
    const weight = page.getByRole("spinbutton", { name: "Weight" }).first();
    const next = String(Math.min(Number(await weight.inputValue()) + 1, 999));
    await weight.fill(next);
    await save.click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Weight" }).first()).toHaveValue(next);

    // The stand-in scorer grades every criterion 3, so each sample scores 51 and a group has no spread.
    await page.getByRole("button", { name: `Try it on version ${version}` }).click();
    const solid = page.getByRole("region", { name: "Results for Solid answers" });
    await expect(solid.getByText("Spread: 0 points")).toBeVisible();
    await expect(solid.getByText("51", { exact: true })).toHaveCount(3);
    await expect(page.getByRole("region", { name: "Results for Red flag answers" })).toBeVisible();

    const reason = `Playwright check: first weight set to ${next}`;
    await page.getByRole("button", { name: `Publish version ${version}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("No Try it run is needed to publish.", { exact: false })).toBeVisible();
    await dialog.getByLabel("Why is the rubric changing?").fill(reason);
    await dialog.getByRole("button", { name: `Publish version ${version}` }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Start a draft from version ${version}` })).toBeVisible();
    await expect(page.getByText(`Reason: ${reason}`)).toBeVisible();
  });
});
