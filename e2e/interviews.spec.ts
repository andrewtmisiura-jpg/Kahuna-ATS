import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../src/db";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";
import { addDays, centralDate } from "../src/server/services/time";

// The profile's interviews panel on a phone, signed in through the development bypass:
// schedule a one-on-one for a snow applicant and record it held with grades, then record
// a ladder test on a window applicant, void it and record it again. Fixtures are written
// straight to the database the dev server reads. The window form is still a draft in a
// fresh seed, so the window applicant pins it directly, which the landing service never
// would; both applications are soft-deleted afterward.

const stamp = `${Date.now()}`.slice(-7);
const snowPerson = { first: "Ivy", last: `Interview${stamp}` };
const windowPerson = { first: "Lad", last: `Ladder${stamp}` };

test.describe("interviews and the ladder test", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let snowApplicationId: string;
  let windowApplicationId: string;

  async function person(who: { first: string; last: string }) {
    const id = uuidv7();
    await db.insert(schema.person).values({
      id,
      firstName: who.first,
      lastName: who.last,
      // A random valid US mobile (local part starting 2 to 8), so repeated runs do not collide.
      mobileE164: `+1651${2_000_000 + Math.floor(Math.random() * 7_000_000)}`,
      email: `${who.last.toLowerCase()}@example.test`,
      emailNormalized: `${who.last.toLowerCase()}@example.test`,
    });
    return id;
  }

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });

    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db
      .select({ id: schema.opening.id })
      .from(schema.opening)
      .where(and(eq(schema.opening.roleId, snow!.id), eq(schema.opening.status, "open")));
    const created = await createApplication(db, {
      personId: await person(snowPerson),
      openingId: open!.id,
      origin: "landing",
      entryChannel: "role_qr",
      actor: { type: "applicant" },
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    snowApplicationId = created.applicationId;
    await transition(db, { action: "submit", applicationId: snowApplicationId, actor: { type: "applicant" }, occurredAt: new Date(Date.now() - 86_400_000) });

    // The window applicant, submitted, pinned to the window draft form.
    const [windowRole] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "window_cleaning_tech"));
    const [windowOpening] = await db.select({ id: schema.opening.id }).from(schema.opening).where(eq(schema.opening.roleId, windowRole!.id));
    const [form] = await db
      .select({ id: schema.formVersion.id })
      .from(schema.formVersion)
      .where(and(eq(schema.formVersion.roleId, windowRole!.id), eq(schema.formVersion.version, 1)));
    const windowStages = await db
      .select({ id: schema.pipelineStage.id, key: schema.pipelineStage.key })
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.roleId, windowRole!.id));
    const stage = (key: string) => windowStages.find((s) => s.key === key)!.id;
    const startedAt = new Date(Date.now() - 2 * 86_400_000);
    const submittedAt = new Date(Date.now() - 86_400_000);
    windowApplicationId = uuidv7();
    await db.insert(schema.application).values({
      id: windowApplicationId,
      personId: await person(windowPerson),
      openingId: windowOpening!.id,
      roleId: windowRole!.id,
      formVersionId: form!.id,
      origin: "staff_created",
      status: "open",
      currentStageId: stage("submitted"),
      stageEnteredAt: submittedAt,
      eventSeq: 2,
      answersLocked: true,
      startedAt,
      submittedAt,
      lastActivityAt: submittedAt,
      entryChannel: "staff_entered",
    });
    await db.insert(schema.applicationEvent).values([
      { id: uuidv7(), applicationId: windowApplicationId, seq: 1, kind: "created", toStageId: stage("started"), toStatus: "open", actorType: "system", occurredAt: startedAt },
      { id: uuidv7(), applicationId: windowApplicationId, seq: 2, kind: "submitted", fromStageId: stage("started"), toStageId: stage("submitted"), actorType: "system", occurredAt: submittedAt },
    ]);
  });

  test.afterAll(async () => {
    if (!sql) return;
    for (const id of [snowApplicationId, windowApplicationId]) {
      if (id) await sql`update application set deleted_at = now() where id = ${id}`;
    }
    await sql.end();
  });

  test("schedules a one-on-one and records it held, with grades and a recommendation", async ({ page }) => {
    // Yesterday in Central time, so the time it was held is never in the future.
    const yesterday = addDays(centralDate(new Date()), -1);
    await page.goto(`/admin/applicants/${snowApplicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(snowPerson.last);
    await expect(page.getByText("No one-on-one or phone screen yet.")).toBeVisible();

    await page.getByRole("button", { name: "Schedule an interview" }).click();
    const schedule = page.getByRole("dialog");
    await expect(schedule.getByRole("heading", { name: "Schedule an interview" })).toBeVisible();
    await expect(schedule.getByLabel("One-on-one")).toBeChecked();
    await schedule.getByLabel("Date", { exact: true }).fill(yesterday);
    await schedule.getByLabel("Time (Central)").fill("10:00");
    await schedule.getByLabel("Booked by").selectOption({ label: "Booking link" });
    await schedule.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(schedule).toBeHidden();
    await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
    await expect(page.getByText(/10:00 AM/).first()).toBeVisible();

    await page.getByRole("button", { name: "Record result" }).click();
    const result = page.getByRole("dialog");
    await expect(result.getByLabel("Held", { exact: true })).toBeChecked();
    await expect(result.getByLabel("Held on")).toHaveValue(yesterday);
    await result.getByLabel("At (Central)").fill("10:05");
    await result.getByLabel("Reliability").selectOption({ label: "A" });
    await result.getByLabel("Work ethic").selectOption({ label: "B+" });
    await result.getByLabel("Safety awareness").selectOption({ label: "A-" });
    await result.getByLabel("Overall grade").selectOption({ label: "B+" });
    await result.getByLabel("Hire", { exact: true }).check();
    await expect(result.getByText(/No medical observations/)).toBeVisible();
    await result.getByLabel("Notes").fill("Asked good questions about ladder safety.");
    await result.getByLabel("Notion link (optional)").fill("https://www.notion.so/kahuna/Interview-notes-0123");
    await result.getByRole("button", { name: "Save result" }).click();
    await expect(result).toBeHidden();

    await expect(page.getByText("Held", { exact: true })).toBeVisible();
    await expect(page.getByText("Asked good questions about ladder safety.")).toBeVisible();
    const grades = page.getByRole("list", { name: "Grades" });
    await expect(grades).toContainText("Reliability");
    await expect(grades).toContainText("Safety awareness");
    await expect(grades.getByText("B+")).toBeVisible();
    await expect(page.getByText("Hire", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the Notion page" })).toHaveAttribute("href", "https://www.notion.so/kahuna/Interview-notes-0123");
    // A snow applicant has no ladder test.
    await expect(page.getByText("Ladder test", { exact: true })).toHaveCount(0);
  });

  test("records a ladder test on a window applicant, then voids it and records it again", async ({ page }) => {
    await page.goto(`/admin/applicants/${windowApplicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(windowPerson.last);
    await expect(page.getByText("Ladder test", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Date of the test")).toHaveValue(centralDate(new Date()));

    await page.getByLabel("Fail", { exact: true }).check();
    await page.getByLabel("Note (restricted, optional)").fill("Stopped at the second floor and came down.");
    await page.getByRole("button", { name: "Save ladder test result" }).click();
    await expect(page.getByText("Stopped at the second floor and came down.")).toBeVisible();
    await expect(page.getByText("Restricted", { exact: true })).toBeVisible();
    // A fail only points at the Close button; the application stays open.
    await expect(page.getByText(/pick Disqualified and the reason "Did not pass the ladder test"/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Void this result" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "Void result" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText("Voided", { exact: true })).toBeVisible();

    await page.getByLabel("Pass", { exact: true }).check();
    await page.getByRole("button", { name: "Save ladder test result" }).click();
    await expect(page.getByText("Pass", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Void this result" })).toBeVisible();
  });
});
