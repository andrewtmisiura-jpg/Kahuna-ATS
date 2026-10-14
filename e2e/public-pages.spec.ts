import { expect, test } from "@playwright/test";

test("home page renders on a phone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Kahuna Window Cleaning");
  await expect(page.getByRole("link", { name: "Privacy policy" })).toBeVisible();
});

test("health endpoint answers", async ({ request }) => {
  const response = await request.get("/health");
  expect([200, 503]).toContain(response.status());
  const body = await response.json();
  expect(body).toHaveProperty("database");
});
