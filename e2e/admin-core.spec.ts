import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";

// The staff review flow on a phone, signed in through the development bypass:
// open the list, open a profile, move with a backdated time, close with a reason,
// reopen, hire now and fill the hire form. Fixtures are written straight to the
// database the dev server reads, since the applicant pages are another area.

test.describe("admin core", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const firstName = "Playwright";
  const lastName = `Tester${stamp}`;
  let applicationId: string;
  let sql: ReturnType<typeof postgres>;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db.select({ id: schema.opening.id }).from(schema.opening).where(eq(schema.opening.roleId, snow!.id));
    const personId = uuidv7();
    await db.insert(schema.person).values({
      id: personId,
      firstName,
      lastName,
      mobileE164: `+16125${stamp.slice(-6)}`,
      email: `pw-${stamp}@example.test`,
      emailNormalized: `pw-${stamp}@example.test`,
    });
    const created = await createApplication(db, {
      personId,
      openingId: open!.id,
      origin: "landing",
      entryChannel: "role_qr",
      actor: { type: "applicant" },
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    applicationId = created.applicationId;
    await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, occurredAt: new Date(Date.now() - 86_400_000) });
  });

  test.afterAll(async () => {
    await sql`update application set deleted_at = now() where id = ${applicationId}`;
    await sql.end();
  });

  async function openProfile(page: Page) {
    await page.goto(`/admin/applicants/${applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${firstName} ${lastName}`);
  }

  test("list, profile, move with a backdated time, close, reopen, hire now and the hire form", async ({ page }) => {
    // The list shows the submitted applicant and the counts.
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Snow Removal 2026-27");
    await expect(page.getByText("Submit rate")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search" }).fill(lastName);
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("link", { name: `${firstName} ${lastName}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(lastName);
    await expect(page.getByText("Stage history")).toBeVisible();

    // Move to Reviewed with a backdated time.
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const moveDialog = page.getByRole("dialog");
    await moveDialog.getByLabel("Stage").selectOption({ label: "Reviewed" });
    await moveDialog.getByLabel("Earlier (backdate)").check();
    const earlier = new Date(Date.now() - 3 * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${earlier.getFullYear()}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}T${pad(earlier.getHours())}:${pad(earlier.getMinutes())}`;
    await moveDialog.locator('input[type="datetime-local"]').fill(local);
    await moveDialog.getByLabel("Note (optional)").fill("Caught up from paper");
    await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(moveDialog).toBeHidden();
    await expect(page.getByText("Reviewed", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Caught up from paper")).toBeVisible();
    await expect(page.getByText(/entered /).first()).toBeVisible();

    // Close with a reason.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const closeDialog = page.getByRole("dialog");
    await closeDialog.getByLabel("Disqualified").check();
    await closeDialog.getByLabel("Reason").selectOption({ label: "Availability doesn't fit" });
    await closeDialog.getByRole("button", { name: "Close application" }).click();
    await expect(closeDialog).toBeHidden();
    await expect(page.getByText("Disqualified: Availability doesn't fit").first()).toBeVisible();

    // Reopen.
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    const reopenDialog = page.getByRole("dialog");
    await reopenDialog.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(reopenDialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Hire now" })).toBeVisible();

    // Hire now opens the hire form; fill it in.
    await page.getByRole("button", { name: "Hire now" }).click();
    const hireDialog = page.getByRole("dialog");
    await expect(hireDialog.getByRole("heading", { name: "Hire record" })).toBeVisible();
    await hireDialog.getByLabel("Start date").fill("2026-11-02");
    await hireDialog.getByLabel("Temporary hire?").getByLabel("Yes").check();
    await hireDialog.getByLabel("Planned end date (optional)").fill("2026-12-31");
    await hireDialog.getByLabel("30-day rating (1 to 5)").fill("4");
    await hireDialog.getByRole("button", { name: "Save hire record" }).click();
    await expect(hireDialog).toBeHidden();
    await expect(page.getByText("Temporary").first()).toBeVisible();
    await expect(page.getByText("Nov 2, 2026")).toBeVisible();
    await expect(page.getByText("4/5")).toBeVisible();
    await expect(page.getByText("Hired", { exact: true }).first()).toBeVisible();
  });

  test("a note can be added from the profile", async ({ page }) => {
    await openProfile(page);
    await page.getByPlaceholder(/Write facts/).fill("No-show 11/3, didn't call");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("No-show 11/3, didn't call")).toBeVisible();
  });
});
