import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { loadApplicationForm, saveAnswer } from "../src/server/services/applications/answers";
import { createApplication, transition } from "../src/server/services/applications/transition";

// The owner's snow questions on the profile, signed in through the development
// bypass: the folded "What to look for" notes, the Blue check badge and the group
// interview arrival select. Needs `pnpm db:changes` on the dev database, so new
// snow applications pin the form with the "How you work" section.

test.describe("profile guidance", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const lastName = `Guidance${stamp}`;
  let applicationId: string;
  let sql: ReturnType<typeof postgres>;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db
      .select({ id: schema.opening.id })
      .from(schema.opening)
      .where(and(eq(schema.opening.roleId, snow!.id), eq(schema.opening.status, "open")));
    const personId = uuidv7();
    await db.insert(schema.person).values({
      id: personId,
      firstName: "Playwright",
      lastName,
      // Seven digits starting with 4, so the phone_us check always accepts it.
      mobileE164: `+19524${stamp.slice(-6)}`,
      email: `pw-guidance-${stamp}@example.test`,
      emailNormalized: `pw-guidance-${stamp}@example.test`,
    });
    const created = await createApplication(db, {
      personId,
      openingId: open!.id,
      origin: "landing",
      entryChannel: "role_qr",
      actor: { type: "applicant" },
      occurredAt: new Date(Date.now() - 2 * 3_600_000),
    });
    applicationId = created.applicationId;
    const form = await loadApplicationForm(db, applicationId);
    const blue = form!.questions.find((q) => q.questionKey === "best_boss_blue");
    if (!blue) throw new Error("best_boss_blue is not on the live snow form: run `pnpm db:changes` against the dev database first");
    await saveAnswer(db, { applicationId, questionVersionId: blue.questionVersionId, revision: 0, value: "Blue. My best boss trusted the crew." });
    await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, occurredAt: new Date(Date.now() - 3_600_000) });
  });

  test.afterAll(async () => {
    if (applicationId) await sql`update application set deleted_at = now() where id = ${applicationId}`;
    await sql.end();
  });

  test("shows what to look for, the Blue check and the arrival select", async ({ page }) => {
    await page.goto(`/admin/applicants/${applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(lastName, { timeout: 30_000 });

    // The Blue answer passes its check; the notes stay folded until opened.
    await expect(page.getByText("Followed the instruction")).toBeVisible();
    const toggles = page.getByRole("button", { name: "What to look for" });
    await expect(toggles).toHaveCount(5);
    await expect(page.getByText(/Pass or fail only: did they start with the word Blue\?/)).toHaveCount(0);
    const blueAnswer = page.locator("dd").filter({ hasText: "Blue. My best boss trusted the crew." });
    await blueAnswer.getByRole("button", { name: "What to look for" }).click();
    await expect(page.getByText(/Pass or fail only: did they start with the word Blue\?/)).toBeVisible();

    // Arrival: set by staff and kept after a reload.
    const arrival = page.getByLabel("Group interview arrival");
    await expect(arrival).toHaveValue("");
    await arrival.selectOption("on_time");
    await expect(page.getByText("No replies yet")).toBeVisible();
    await expect.poll(async () => (await sql`select group_interview_arrival from application where id = ${applicationId}`)[0]?.group_interview_arrival).toBe("on_time");
    await page.reload();
    await expect(page.getByLabel("Group interview arrival")).toHaveValue("on_time");
  });
});
