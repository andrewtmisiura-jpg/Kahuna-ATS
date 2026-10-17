import { expect, test } from "@playwright/test";
import postgres from "postgres";

// Settings > Roles and stages on a phone, signed in as an Admin through the development
// bypass: create a test role from the snow role without the builder, see its stages,
// add a custom stage and move it. The role is named for this run, never anything
// another spec looks for, and everything it made is deleted afterward: nothing in it
// was published or used, so nothing it made is locked.

const stamp = `${Date.now()}`.slice(-7);
const title = `Playwright Role ${stamp}`;
const key = `pw_role_${stamp}`;

test.describe("roles and stages", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  let sql: ReturnType<typeof postgres>;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  });

  test.afterAll(async () => {
    if (!sql) return;
    const roles = await sql<{ id: string }[]>`select id from role where key = ${key}`;
    for (const { id } of roles) {
      await sql`delete from form_item where form_version_id in (select id from form_version where role_id = ${id})`;
      await sql`delete from form_version where role_id = ${id}`;
      await sql`delete from question_version where question_id in (select id from question where role_id = ${id})`;
      await sql`delete from question where role_id = ${id}`;
      await sql`delete from picklist_option where role_id = ${id}`;
      await sql`delete from pipeline_stage where role_id = ${id}`;
      await sql`delete from opening where role_id = ${id}`;
      await sql`delete from role where id = ${id}`;
    }
    await sql.end();
  });

  test("creates a test role from the snow role, shows its stages and adds a custom stage", async ({ page }) => {
    await page.goto("/admin/settings/roles");
    await expect(page.getByRole("heading", { level: 1, name: "Roles and stages" })).toBeVisible();
    await page.getByRole("link", { name: "New role" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New role" })).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Copy from").selectOption({ label: "Snow Removal Technician (on-call)" });
    await expect(page.getByText(/^Copies 8 stages, \d+ questions from its live form/)).toBeVisible();
    await page.getByLabel("Job title applicants see").fill(title);
    // The staff name follows the title until it is edited.
    await expect(page.getByLabel("Name staff see")).toHaveValue(title);
    await page.getByLabel("Key", { exact: true }).fill(key);
    await expect(page.getByLabel("Copy the questions")).toBeChecked();
    await page.getByRole("button", { name: "Create role" }).click();

    await page.waitForURL(/\/admin\/settings\/roles\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByText("Role created", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit the questions" }).first()).toBeVisible();
    await expect(page.getByText("No openings yet.", { exact: false })).toBeVisible();

    // The snow pipeline came across.
    const stages = page.getByRole("list", { name: "Stages" });
    await expect(stages.getByRole("listitem")).toHaveCount(8);
    await expect(stages.getByRole("listitem").first()).toContainText("1. Started");
    await expect(stages).toContainText("Background or driving check");
    await expect(page.getByRole("button", { name: "Move Started up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Archive Submitted" })).toHaveCount(0);

    // Add a custom stage after Reviewed.
    await page.getByRole("button", { name: "Add a stage" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Phone screen");
    await dialog.getByLabel("What applicants see").fill("Under review");
    await expect(dialog.getByLabel("Counts as")).toHaveValue("");
    await dialog.getByLabel("Put it after").selectOption({ label: "Reviewed" });
    await dialog.getByRole("button", { name: "Add stage" }).click();
    await expect(dialog).toBeHidden();
    await expect(stages.getByRole("listitem")).toHaveCount(9);
    await expect(stages.getByRole("listitem").nth(3)).toContainText("4. Phone screen");
    await expect(stages.getByRole("listitem").nth(3)).toContainText("Custom, no milestone");

    // Down one: it now follows One-on-one invited.
    await page.getByRole("button", { name: "Move Phone screen down" }).click();
    await expect(stages.getByRole("listitem").nth(4)).toContainText("5. Phone screen");
    await expect(stages.getByRole("listitem").nth(3)).toContainText("One-on-one invited");

    // The roles list shows the new role with its draft form.
    await page.getByRole("link", { name: "All roles" }).click();
    const card = page.getByRole("link", { name: new RegExp(title) });
    await expect(card).toContainText("9 stages");
    await expect(card).toContainText("Draft v1");
  });
});
