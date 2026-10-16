import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

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
    for (const name of ["Openings", "Users", "Texting", "Entry codes", "Picklists", "Roles and stages", "Message templates", "AI scoring"]) {
      await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }
  });
});

// The Quo connection card with a signing secret really stored, so "never a secret"
// can fail: the stored value must appear nowhere in the page, its RSC payload
// included, or in the raw server response.
test.describe("Settings > Texting with a stored Quo secret", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const ours = "whsec_" + randomBytes(24).toString("base64");
  let sql: ReturnType<typeof postgres>;
  let inserted = false;
  let secret = ours;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const rows = await sql`
      insert into integration_secret (key, value, note) values ('quo_webhook_secret', ${ours}, 'Playwright: admin-pages.spec.ts')
      on conflict (key) do nothing returning key`;
    inserted = rows.length > 0;
    // A developer's real stored secret stays as it is, and the page must not show that one either.
    const [row] = await sql<{ value: string }[]>`select value from integration_secret where key = 'quo_webhook_secret'`;
    secret = row!.value;
  });

  test.afterAll(async () => {
    if (!sql) return;
    if (inserted) await sql`delete from integration_secret where key = 'quo_webhook_secret' and value = ${ours}`;
    await sql.end();
  });

  test("Settings > Texting shows the Quo connection and never the secret", async ({ page }) => {
    await page.goto("/admin/settings/texting");
    await expect(page.getByText("Quo connection", { exact: true })).toBeVisible();
    await expect(page.getByText("Webhook (replies and delivery updates)")).toBeVisible();
    await expect(page.getByText(/^Connected/).first()).toBeVisible();
    await expect(page.getByText(/^(Last setup:|No setup has run yet)/)).toBeVisible();

    const fragments = [secret, secret.replace(/^whsec_/, ""), secret.slice(-16)];
    const html = await page.content();
    const raw = await (await page.request.get("/admin/settings/texting")).text();
    const rsc = await (await page.request.get("/admin/settings/texting", { headers: { RSC: "1" } })).text();
    for (const text of [html, raw, rsc]) {
      expect(text.length).toBeGreaterThan(0);
      for (const fragment of fragments) expect(text).not.toContain(fragment);
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
