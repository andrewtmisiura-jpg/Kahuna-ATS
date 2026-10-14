import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// The Exports page, signed in as an Admin through the development bypass: pick
// the snow opening, download the wide file and check its header row.

test.describe("exports", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL, "needs DEV_AUTH_EMAIL for the development sign-in bypass");

  test("an Admin downloads the wide export with its header row", async ({ page }) => {
    await page.goto("/admin/exports");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Exports");

    // The wide file needs an opening first.
    const row = page.getByRole("row").filter({ hasText: "Applications (wide, per opening)" });
    await expect(row.getByText("Pick an opening first")).toBeVisible();
    await page.getByLabel("Opening").selectOption({ label: "Snow Removal 2026-27 (open)" });

    const link = row.getByRole("link", { name: "Download CSV" });
    await expect(link).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);

    const path = await download.path();
    const text = (await readFile(path, "utf8")).replace(/^﻿/, "");
    const header = text.split(/\r?\n/)[0]!;
    const columns = header.split(",").map((cell) => cell.replace(/^"|"$/g, ""));
    expect(columns.slice(0, 4)).toEqual(["application_id", "person_id", "first_name", "last_name"]);
    expect(columns).toContain("status");
    expect(columns).toContain("source");
  });
});
