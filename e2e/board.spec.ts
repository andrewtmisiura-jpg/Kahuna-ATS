import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../src/db";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";

// The kanban board, signed in through the development bypass. On the desktop
// project: drag a card from Submitted to Reviewed and find the move in the stage
// history with the actor; drag into Hired, cancel (the card snaps back), then
// drag again and get the Move dialog and the hire form; a stale drag after the
// application changed underneath shows who changed it. On the phone project the
// board is replaced by a note pointing at the list. Fixtures are written straight
// to the database the dev server reads, and the board is filtered to this run's
// surnames so other data never gets in the way.

const stamp = `${Date.now()}`.slice(-7);
const surname = (who: string) => `${who}${stamp}`;
const mover = { first: "Mara", last: surname("Mover") };
const hire = { first: "Hugo", last: surname("Hirable") };
const stale = { first: "Stella", last: surname("Stale") };
const backer = { first: "Rita", last: surname("Backer") };
const fullName = (p: { first: string; last: string }) => `${p.first} ${p.last}`;

// Pointer drag: press on the card, nudge past the activation distance, glide to the target, release.
async function dragTo(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 4, { steps: 4 });
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(90, to.height / 2), { steps: 15 });
  await page.mouse.up();
}

test.describe("board on a desktop", () => {
  test.skip(({ isMobile }) => isMobile, "The board is a desktop screen; the phone gets a note instead");
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let openingId: string;
  let adminId: string;
  const ids: Record<string, string> = {};
  const stages: Record<string, string> = {};

  async function submittedApplication(who: { first: string; last: string }) {
    const personId = uuidv7();
    await db.insert(schema.person).values({
      id: personId,
      firstName: who.first,
      lastName: who.last,
      // A random valid US mobile (local part starting 2 to 8), so repeated runs do not collide.
      mobileE164: `+1763${2_000_000 + Math.floor(Math.random() * 7_000_000)}`,
      email: `board-${who.last.toLowerCase()}@example.test`,
      emailNormalized: `board-${who.last.toLowerCase()}@example.test`,
    });
    const { applicationId } = await createApplication(db, {
      personId,
      openingId,
      origin: "landing",
      entryChannel: "role_qr",
      actor: { type: "applicant" },
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, occurredAt: new Date(Date.now() - 86_400_000) });
    ids[who.last] = applicationId;
    return applicationId;
  }

  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    db = drizzle({ client: sql, schema, casing: "snake_case" });
    const adminEmail = process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL!;
    await seedPhase1(db, { adminEmail });
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db
      .select({ id: schema.opening.id })
      .from(schema.opening)
      .where(and(eq(schema.opening.roleId, snow!.id), eq(schema.opening.status, "open")));
    openingId = open!.id;
    for (const stage of await db.select().from(schema.pipelineStage).where(eq(schema.pipelineStage.roleId, snow!.id))) stages[stage.key] = stage.id;
    const [admin] = await db.select({ id: schema.appUser.id }).from(schema.appUser).where(eq(schema.appUser.email, process.env.DEV_AUTH_EMAIL!));
    adminId = admin?.id ?? (await db.select({ id: schema.appUser.id }).from(schema.appUser).where(eq(schema.appUser.email, adminEmail)))[0]!.id;

    await submittedApplication(mover);
    await submittedApplication(stale);
    const staff = { type: "staff" as const, userId: adminId };
    const backerId = await submittedApplication(backer);
    await transition(db, { action: "move", applicationId: backerId, toStageId: stages.reviewed!, actor: staff });
    const hireId = await submittedApplication(hire);
    // Through the offer and the check, so Hired is the next column over.
    await transition(db, { action: "move", applicationId: hireId, toStageId: stages.conditional_offer!, actor: staff });
    await transition(db, { action: "move", applicationId: hireId, toStageId: stages.background_check!, actor: staff, check: { checkType: "criminal" } });
  });

  test.afterAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    const list = Object.values(ids);
    if (list.length) await sql`update application set deleted_at = now() where id in ${sql(list)}`;
    await sql.end();
  });

  const boardUrl = () => `/admin/board?opening=${openingId}&q=${stamp}`;
  // CSS locators, not roles: an open dialog hides the board from the accessibility tree,
  // and the tests look at the board behind the Move dialog.
  const column = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);
  const cardIn = (region: Locator, who: { first: string; last: string }) => region.locator("li").filter({ hasText: fullName(who) });

  test("drag from Submitted to Reviewed, then find the move in the stage history with the actor", async ({ page }) => {
    await page.goto(boardUrl());
    await expect(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();
    await expect(page.getByText("started, not submitted")).toBeVisible();
    const submitted = column(page, "Submitted");
    const reviewed = column(page, "Reviewed");
    await expect(cardIn(submitted, mover)).toBeVisible();
    await expect(cardIn(submitted, mover)).toContainText("Submitted");

    await dragTo(page, cardIn(submitted, mover), reviewed);
    await expect(cardIn(reviewed, mover)).toBeVisible();
    await expect(cardIn(submitted, mover)).toHaveCount(0);
    await expect(reviewed.getByText("Saving")).toHaveCount(0);

    // After a reload the move is still there: it came from the server.
    await page.reload();
    await expect(cardIn(column(page, "Reviewed"), mover)).toBeVisible();

    // The card opens the profile with the opening in the link, for Previous and Next.
    await column(page, "Reviewed").getByRole("link", { name: fullName(mover) }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/applicants/${ids[mover.last]}\\?opening=${openingId}`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(fullName(mover));
    const entry = page.getByRole("listitem").filter({ hasText: "Submitted to Reviewed" });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(process.env.DEV_AUTH_EMAIL!);
  });

  test("drag into Hired opens the Move dialog, cancel snaps back, Move opens the hire form", async ({ page }) => {
    await page.goto(boardUrl());
    const check = column(page, "Background or driving check");
    const hired = column(page, "Hired");
    await page.locator("[data-board]").evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(cardIn(check, hire)).toBeVisible();

    // Cancel puts the card back where it was.
    await dragTo(page, cardIn(check, hire), hired);
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Move" })).toBeVisible();
    await expect(dialog.getByLabel("Stage")).toHaveValue(stages.hired!);
    await expect(cardIn(hired, hire)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(cardIn(check, hire)).toBeVisible();
    await expect(cardIn(hired, hire)).toHaveCount(0);

    // Again, and this time move: the hire form opens on the new record.
    await dragTo(page, cardIn(check, hire), hired);
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Temporary hire?")).toBeVisible();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    const hireForm = page.getByRole("dialog");
    await expect(hireForm.getByRole("heading", { name: "Hire record" })).toBeVisible();
    await hireForm.getByLabel("Temporary hire?").getByLabel("Yes").check();
    await hireForm.getByRole("button", { name: "Save hire record" }).click();
    await expect(hireForm).toBeHidden();
    await expect(cardIn(hired, hire)).toContainText("Temporary");
    await expect(cardIn(check, hire)).toHaveCount(0);
  });

  test("a stale drag says who changed the application and reloads", async ({ page }) => {
    await page.goto(boardUrl());
    const submitted = column(page, "Submitted");
    await expect(cardIn(submitted, stale)).toBeVisible();

    // Someone else changes the application after the board was loaded.
    await transition(db, { action: "contacted", applicationId: ids[stale.last]!, actor: { type: "staff", userId: adminId } });

    // A keyboard drag: the grip is the handle; Right picks the next column, Space drops.
    const handle = page.getByRole("button", { name: `Move ${fullName(stale)}` });
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("status").filter({ hasText: `${fullName(stale)} is over Reviewed.` })).toBeAttached();
    await page.keyboard.press("Space");

    await expect(page.getByText(new RegExp(`Changed by ${process.env.DEV_AUTH_EMAIL!.replace(/[.]/g, "\\.")} at .+\\. Reloading\\.`))).toBeVisible();
    // The drag is never re-applied: the card snaps back to Submitted.
    await expect(cardIn(submitted, stale)).toBeVisible();
    await expect(cardIn(column(page, "Reviewed"), stale)).toHaveCount(0);
    const [row] = await db
      .select({ stageId: schema.application.currentStageId, seq: schema.application.eventSeq })
      .from(schema.application)
      .where(eq(schema.application.id, ids[stale.last]!));
    expect(row!.stageId).toBe(stages.submitted);

    // The reload brings the new version, so the same drag now goes through.
    await expect(cardIn(submitted, stale)).toHaveAttribute("data-version", String(row!.seq));
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("status").filter({ hasText: `${fullName(stale)} is over Reviewed.` })).toBeAttached();
    await page.keyboard.press("Space");
    await expect(cardIn(column(page, "Reviewed"), stale)).toHaveAttribute("data-version", String(row!.seq + 1));
  });

  test("moving back asks first, and the Close zone opens the Close dialog", async ({ page }) => {
    await page.goto(boardUrl());
    const submitted = column(page, "Submitted");
    const reviewed = column(page, "Reviewed");
    await expect(cardIn(reviewed, backer)).toBeVisible();

    // Back to Submitted: asked first; Cancel snaps the card back.
    await dragTo(page, cardIn(reviewed, backer), submitted);
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByRole("heading", { name: "Move back?" })).toBeVisible();
    await expect(cardIn(submitted, backer)).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(cardIn(reviewed, backer)).toBeVisible();
    await expect(cardIn(submitted, backer)).toHaveCount(0);

    // Keyboard drag across the board to the Close zone at the end.
    const handle = page.getByRole("button", { name: `Move ${fullName(backer)}` });
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    for (const next of ["One-on-one invited", "One-on-one done", "Conditional offer", "Background or driving check", "Hired", "Close"]) {
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("status").filter({ hasText: `${fullName(backer)} is over ${next}.` })).toBeAttached();
    }
    await page.keyboard.press("Space");
    const closeDialog = page.getByRole("dialog");
    await expect(closeDialog.getByRole("heading", { name: "Close" })).toBeVisible();
    await closeDialog.getByLabel("Withdrew").check();
    await closeDialog.getByLabel("Reason").selectOption({ label: "Stopped responding" });
    await closeDialog.getByRole("button", { name: "Close application" }).click();
    await expect(closeDialog).toBeHidden();
    await expect(cardIn(reviewed, backer)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /1 closed/ })).toBeVisible();
  });
});

test.describe("board on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "Only phones get the note");
  test.skip(!process.env.DEV_AUTH_EMAIL, "needs DEV_AUTH_EMAIL for the development sign-in bypass");

  test("shows a note that links to the list instead of the board", async ({ page }) => {
    await page.goto("/admin/board");
    await expect(page.getByText("The board needs a wider screen.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Submitted" })).toBeHidden();
    await page.getByRole("link", { name: "Open the list" }).click();
    await expect(page).toHaveURL(/\/admin\?opening=/);
    await expect(page.getByText("Submit rate")).toBeVisible();
  });
});
