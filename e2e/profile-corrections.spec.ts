import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";

// The profile's corrections on a phone, signed in through the development
// bypass: rescind a hire back to the stage before Hired, undo that after the
// confirmation names it, change how they heard and set the group session.
// Fixtures go straight to the database the dev server reads.

test.describe("profile corrections", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const lastName = `Rescind${stamp}`;
  const location = `Plymouth office ${stamp}`;
  let applicationId: string;
  let sessionId: string;
  let sql: ReturnType<typeof postgres>;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db.select({ id: schema.opening.id }).from(schema.opening).where(eq(schema.opening.roleId, snow!.id));
    const stages = await db.select().from(schema.pipelineStage).where(eq(schema.pipelineStage.roleId, snow!.id));
    const stage = (key: string) => stages.find((s) => s.key === key)!.id;
    // Any active Admin stands in as the staff member who made the earlier moves.
    const [staffUser] = await db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(and(eq(schema.appUser.role, "admin"), eq(schema.appUser.status, "active")))
      .limit(1);
    const staff = { type: "staff" as const, userId: staffUser!.id };

    sessionId = uuidv7();
    await db.insert(schema.groupSession).values({
      id: sessionId,
      openingId: open!.id,
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      locationName: location,
      status: "scheduled",
      createdBy: staffUser!.id,
    });

    const personId = uuidv7();
    await db.insert(schema.person).values({
      id: personId,
      firstName: "Playwright",
      lastName,
      // Seven digits starting with 5, so the phone_us check always accepts it.
      mobileE164: `+17635${stamp.slice(-6)}`,
      email: `pw-rescind-${stamp}@example.test`,
      emailNormalized: `pw-rescind-${stamp}@example.test`,
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
    await transition(db, { action: "move", applicationId, toStageId: stage("reviewed"), actor: staff, occurredAt: new Date(Date.now() - 3_600_000) });
    await transition(db, { action: "move", applicationId, toStageId: stage("hired"), actor: staff });
  });

  test.afterAll(async () => {
    if (applicationId) await sql`update application set deleted_at = now() where id = ${applicationId}`;
    if (sessionId) await sql`update group_session set deleted_at = now() where id = ${sessionId}`;
    await sql.end();
  });

  test("rescind back to a stage, undo it, then change the source and the session", async ({ page }) => {
    await page.goto(`/admin/applicants/${applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(lastName);

    // Rescind the hire back to the stage before Hired, which the dialog picks by default.
    await page.getByRole("button", { name: "Rescind hire" }).click();
    const rescind = page.getByRole("dialog");
    await rescind.getByLabel("Put it back in a stage").check();
    await expect(rescind.getByLabel("Back to stage")).toHaveValue(/.+/);
    await expect(rescind.getByLabel("Back to stage").locator("option:checked")).toHaveText("Reviewed");
    await rescind.getByLabel("Why is the hire rescinded? (required)").fill("Start date fell through");
    await rescind.getByRole("button", { name: "Rescind hire" }).click();
    await expect(rescind).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Hire now" })).toBeVisible();
    await expect(page.getByText("Hire rescinded", { exact: true })).toBeVisible();

    // Undo names the rescission, then puts the hire back.
    await page.getByRole("button", { name: "Undo last change" }).click();
    const undo = page.getByRole("dialog");
    await expect(undo.getByText("Hire rescinded, back to Reviewed")).toBeVisible();
    await expect(undo.getByText("The application is hired again and its hire record comes back.")).toBeVisible();
    await undo.getByRole("button", { name: "Undo this change" }).click();
    await expect(undo).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Rescind hire" })).toBeVisible();
    await expect(page.getByText("Hire rescinded (voided)")).toBeVisible();

    // How they heard, with the applicant's labels.
    await page.getByRole("button", { name: "Change how they heard" }).click();
    const sourceForm = page.locator("form").filter({ has: page.getByLabel("How did you hear about us?") });
    await sourceForm.getByLabel("How did you hear about us?").selectOption({ label: "Someone referred me" });
    await sourceForm.getByLabel("Who referred them?").fill("Jamie at the shop");
    await sourceForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Someone referred me (Jamie at the shop)")).toBeVisible({ timeout: 30_000 });

    // The group session, linked to its page.
    await page.getByRole("button", { name: "Change group session" }).click();
    const sessionForm = page.locator("form").filter({ has: page.getByLabel("Attributed session") });
    await sessionForm.getByLabel("Attributed session").selectOption(sessionId);
    await sessionForm.getByRole("button", { name: "Save" }).click();
    const link = page.getByRole("link", { name: new RegExp(location) });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute("href", `/admin/sessions/${sessionId}`);
    await expect(page.getByText("(set by staff)")).toBeVisible();
  });
});
