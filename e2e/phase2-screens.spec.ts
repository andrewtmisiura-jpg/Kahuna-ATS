import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { uuidv7 } from "../src/lib/uuid";

// The Phase 2 screens on a phone, signed in through the development bypass: the three
// new Settings screens, open to Admins, and the door check-in kiosk, which people at the
// door see, so it carries the Kahuna name, never Tidepool, and no admin navigation.
// These check what stays true once each screen is built, not the placeholder wording.

test.describe("Phase 2 screens", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  let sql: ReturnType<typeof postgres>;
  let sessionId: string | undefined;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const [opening] = await sql<{ id: string }[]>`
      select o.id from opening o join role r on r.id = o.role_id where r.key = 'snow_removal_tech' and o.status = 'open'`;
    const [admin] = await sql<{ id: string }[]>`
      select id from app_user where role = 'admin' and status = 'active' order by created_at limit 1`;
    sessionId = uuidv7();
    await sql`
      insert into group_session (id, opening_id, starts_at, location_name, status, created_by)
      values (${sessionId}, ${opening!.id}, now(), 'Playwright kiosk check', 'scheduled', ${admin!.id})`;
  });

  test.afterAll(async () => {
    if (!sql) return;
    if (sessionId) await sql`delete from group_session where id = ${sessionId}`;
    await sql.end();
  });

  test("Settings opens Roles and stages, Message templates and AI scoring", async ({ page }) => {
    const screens = [
      ["/admin/settings/roles", "Roles and stages"],
      ["/admin/settings/templates", "Message templates"],
      ["/admin/settings/scoring", "AI scoring"],
    ] as const;
    for (const [path, title] of screens) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByText("Admins only")).toHaveCount(0);
    }
  });

  test("the door check-in carries the Kahuna name and no admin navigation", async ({ page }) => {
    await page.goto(`/check-in/${sessionId}`);
    await expect(page.getByText("Kahuna Window Cleaning", { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/Kahuna Window Cleaning/);
    for (const name of ["List", "Board", "Sessions", "Settings"]) {
      await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.locator("body")).not.toContainText("Tidepool");
  });
});
