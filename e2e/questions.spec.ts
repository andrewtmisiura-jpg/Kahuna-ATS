import { expect, test } from "@playwright/test";

// The question editor end to end, signed in as an Admin through the development
// bypass: start a draft of the snow form, reword one question as the same
// question, publish with a reason and see the new version live. It rewords an
// optional question the applicant spec never touches, so running both together
// is safe, and it works out the version numbers from the page, so it can run
// again on the same database (a fresh seed publishes v2).

test.describe("question editor", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL, "needs DEV_AUTH_EMAIL for the development sign-in bypass");

  test("an Admin rewords a question and publishes the next version", async ({ page }) => {
    const stamp = Date.now().toString().slice(-6);
    const reworded = `How did that job end? (reworded ${stamp})`;

    await page.goto("/admin/questions");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Questions");
    await page.getByRole("link", { name: /Snow Removal Technician/ }).click();
    // The dev server compiles the editor route on first use, which can take a while.
    await page.waitForURL(/\/admin\/questions\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Snow Removal Technician", { timeout: 30_000 });

    const tabs = page.getByRole("tablist", { name: "Form versions" });
    // On the Draft tab, start a draft from the live version, unless an earlier run left one open.
    await tabs.getByRole("tab", { name: /^Draft/ }).click();
    const start = page.getByRole("button", { name: /^Start a draft from version \d+$/ });
    const draftTab = tabs.getByRole("tab", { name: /^Draft v\d+$/ });
    await expect(start.or(draftTab)).toBeVisible();
    if (await start.isVisible()) await start.click();
    await expect(draftTab).toBeVisible({ timeout: 30_000 });
    const version = Number((await draftTab.innerText()).replace(/\D/g, ""));
    expect(version).toBeGreaterThanOrEqual(2);
    await draftTab.click();

    // Edit the wording of "How did that job end?" and keep it the same question.
    const row = page.getByRole("listitem").filter({ hasText: /How did that job end\?/ });
    await row.getByRole("button", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByRole("heading", { name: "Edit question" })).toBeVisible();
    await editDialog.getByLabel("Question", { exact: true }).fill(reworded);
    await editDialog.getByLabel("Same question, reworded").check();
    await editDialog.getByRole("button", { name: "Save" }).click();
    await expect(editDialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(reworded)).toBeVisible();

    // Publish with a written reason.
    await page.getByRole("button", { name: `Publish version ${version}` }).click();
    const publishDialog = page.getByRole("dialog");
    await publishDialog.getByLabel("Why is the form changing?").fill("Clearer wording for the job history question");
    await publishDialog.getByRole("button", { name: `Publish version ${version}` }).click();
    await expect(publishDialog).toBeHidden({ timeout: 30_000 });

    // The new version is live and shows the new wording.
    const publishedTab = tabs.getByRole("tab", { name: `Published v${version}` });
    await expect(publishedTab).toBeVisible({ timeout: 30_000 });
    await publishedTab.click();
    await expect(publishedTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(reworded)).toBeVisible();

    await page.goto("/admin/questions");
    await expect(page.getByText(`Published v${version}`).first()).toBeVisible();
  });
});
