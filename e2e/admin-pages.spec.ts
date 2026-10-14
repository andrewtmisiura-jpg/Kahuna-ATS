import { expect, test } from "@playwright/test";

// Runs only under the development sign-in bypass (DEV_AUTH_EMAIL in .env).
test.describe("admin shell", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL, "needs DEV_AUTH_EMAIL for the development sign-in bypass");

  test("list page renders with the phone bottom nav", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Snow Removal 2026-27");
    await expect(page.getByRole("link", { name: "Board" })).toBeVisible();
    await expect(page.getByText("dev sign-in")).toBeVisible();
  });

  test("settings index links to every settings screen", async ({ page }) => {
    await page.goto("/admin/settings");
    for (const name of ["Openings", "Users", "Texting", "Entry codes", "Picklists"]) {
      await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }
  });
});

test("sign-in page is reachable without a session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/admin/sign-in");
  await expect(page.getByText("Tidepool", { exact: true })).toBeVisible();
  await context.close();
});
