import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runChanges } from "../src/db/changes";
import { phase2Templates } from "../src/db/changes/phase2-templates";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";
import { recordConsent } from "../src/server/services/messaging/consent";

// Message templates on a phone, signed in through the development bypass: an Admin edits
// the status update text and watches the preview, and a move to One-on-one invited with
// the invite ticked queues the invite as a text, shown in the profile's thread. The sink
// provider is in use locally and nothing sends during the test (the cron is not running).

test.describe("message templates", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const lastName = `Invite${stamp}`;
  const sampleLink = "https://book.example.com/kahuna-hiring/interview30";
  let sql: ReturnType<typeof postgres>;
  let employerId: string;
  let bookingLink: string;
  let setBookingLink = false;
  let statusText: { id: string; name: string; body: string };
  let applicationId: string;

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    // `pnpm db:changes` adds the Phase 2 templates; a checkout that has not run it yet gets them here.
    await runChanges(db, [phase2Templates]);

    const [emp] = await db.select().from(schema.employer).where(eq(schema.employer.key, "kahuna"));
    employerId = emp!.id;
    bookingLink = emp!.bookingLinkUrl ?? sampleLink;
    if (!emp!.bookingLinkUrl) {
      await db.update(schema.employer).set({ bookingLinkUrl: sampleLink }).where(eq(schema.employer.id, employerId));
      setBookingLink = true;
    }
    const [status] = await db
      .select()
      .from(schema.messageTemplate)
      .where(
        and(
          eq(schema.messageTemplate.employerId, employerId),
          eq(schema.messageTemplate.purpose, "status_update"),
          eq(schema.messageTemplate.channel, "sms"),
        ),
      );
    statusText = { id: status!.id, name: status!.name, body: status!.body };

    // A submitted snow applicant who ticked the text box.
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db.select({ id: schema.opening.id }).from(schema.opening).where(eq(schema.opening.roleId, snow!.id));
    const personId = uuidv7();
    const mobile = `+19525${stamp.slice(-6)}`;
    await db.insert(schema.person).values({
      id: personId,
      firstName: "Playwright",
      lastName,
      mobileE164: mobile,
      email: `pw-invite-${stamp}@example.test`,
      emailNormalized: `pw-invite-${stamp}@example.test`,
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
    const [consent] = await db.select({ id: schema.legalTextVersion.id }).from(schema.legalTextVersion).where(eq(schema.legalTextVersion.kind, "sms_consent"));
    await recordConsent(db, {
      personId,
      applicationId,
      employerId,
      channel: "sms",
      address: mobile,
      action: "opt_in",
      method: "web_form",
      legalTextVersionId: consent!.id,
      checkboxValue: true,
      occurredAt: new Date(Date.now() - 2 * 86_400_000),
    });
  });

  test.afterAll(async () => {
    if (!sql) return;
    if (statusText) await sql`update message_template set name = ${statusText.name}, body = ${statusText.body} where id = ${statusText.id}`;
    if (applicationId) {
      await sql`update message set status = 'canceled' where application_id = ${applicationId} and status = 'queued'`;
      await sql`update application set deleted_at = now() where id = ${applicationId}`;
    }
    if (setBookingLink) await sql`update employer set booking_link_url = null where id = ${employerId} and booking_link_url = ${sampleLink}`;
    await sql.end();
  });

  test("an Admin edits the status update text and sees the preview", async ({ page }) => {
    await page.goto("/admin/settings/templates");
    await expect(page.getByRole("heading", { level: 1, name: "Message templates" })).toBeVisible();
    await expect(page.getByText("One-on-one booking link", { exact: true })).toBeVisible();

    const card = page.getByRole("region", { name: "Status update (text)" });
    await card.getByRole("button", { name: "Edit" }).click();
    const message = card.getByLabel("Message", { exact: true });
    const preview = card.getByTestId("template-preview");

    // A placeholder Tidepool does not know stops the save.
    await message.fill("Kahuna Window Cleaning: Hi {first}, news: {link} Reply STOP to opt out.");
    await expect(card.getByText("Fix before saving")).toBeVisible();
    await expect(card.getByText("{first} is not a placeholder Tidepool fills in. Pick one from the list, like {first_name}.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();

    const body = `Kahuna Window Cleaning: Hi {first_name}, news on your application (${stamp}): {link} Reply STOP to opt out.`;
    await message.fill(body);
    await expect(preview).toContainText(`Hi Marcus, news on your application (${stamp}): https://`);
    await expect(preview).not.toContainText("{first_name}");
    await expect(card.getByText(/^\d+ characters, \d segments?\. The first text after someone opts in/)).toBeVisible();
    await expect(card.getByText("Follows every rule for texts.")).toBeVisible();

    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(card.getByText(body)).toBeVisible();
  });

  test("a move to One-on-one invited with the invite ticked queues the invite text in the thread", async ({ page }) => {
    await page.goto(`/admin/applicants/${applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Playwright ${lastName}`);

    await page.getByRole("button", { name: "Move", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Stage").selectOption({ label: "One-on-one invited" });
    const invite = dialog.getByLabel("Also send the one-on-one invite");
    await expect(invite).toBeChecked();
    await expect(dialog.getByText(`Hi Playwright, we'd like to interview you. Pick a time here: ${bookingLink} Reply STOP to opt out.`)).toBeVisible();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();

    // The invite waits in the thread for the cron, as a text. (The stage history says "invited".)
    const thread = page.locator("li").filter({ hasText: /One-on-one invite(?!d)/ });
    await expect(thread).toHaveCount(1);
    await expect(thread).toContainText("Text");
    await expect(thread).toContainText("Queued");
    await expect(thread).toContainText(`we'd like to interview you. Pick a time here: ${bookingLink}`);

    // Send a message: the status update, chosen and previewed, joins it.
    await page.getByRole("button", { name: "Send a message" }).click();
    const send = page.getByRole("dialog");
    await send.getByLabel(/Status update/).check();
    await expect(send.getByText("[application link]")).toBeVisible();
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toBeHidden();
    await expect(page.locator("li").filter({ hasText: "Status update" })).toContainText("Queued");
  });
});
