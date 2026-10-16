import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedPhase1 } from "../src/db/seed";
import { uuidv7 } from "../src/lib/uuid";
import { createApplication, transition } from "../src/server/services/applications/transition";

// A group session on a phone, signed in through the development bypass: create the
// session, type in a name from the sign-up sheet whose mobile matches an applicant,
// star them on the floor view with a reason and see the star on their profile. Then
// the door check-in kiosk: a person types a name and the mobile of an applicant on
// file, and the check-in is matched to that application by phone.

test.describe("group sessions", () => {
  test.skip(!process.env.DEV_AUTH_EMAIL || !process.env.DATABASE_URL, "needs DEV_AUTH_EMAIL and DATABASE_URL");

  const stamp = Date.now().toString().slice(-7);
  const location = `Playwright floor ${stamp}`;
  const doorLocation = `Playwright door ${stamp}`;
  let sql: ReturnType<typeof postgres>;
  let openingId: string;
  let doorSessionId: string;
  const people = {
    // Seven digits starting with 2 or 3, so the phone_us check always accepts them.
    sheet: { firstName: "Sheet", lastName: `Floorstar${stamp}`, mobile: `+16512${stamp.slice(-6)}`, applicationId: "" },
    door: { firstName: "Door", lastName: `Kiosk${stamp}`, mobile: `+16513${stamp.slice(-6)}`, applicationId: "" },
  };

  test.beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = drizzle({ client: sql, schema, casing: "snake_case" });
    await seedPhase1(db, { adminEmail: process.env.ADMIN_EMAIL ?? process.env.DEV_AUTH_EMAIL! });
    const [snow] = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.key, "snow_removal_tech"));
    const [open] = await db
      .select({ id: schema.opening.id })
      .from(schema.opening)
      .where(and(eq(schema.opening.roleId, snow!.id), eq(schema.opening.status, "open")));
    openingId = open!.id;
    for (const who of Object.values(people)) {
      const personId = uuidv7();
      await db.insert(schema.person).values({
        id: personId,
        firstName: who.firstName,
        lastName: who.lastName,
        mobileE164: who.mobile,
        email: `pw-${who.lastName.toLowerCase()}@example.test`,
        emailNormalized: `pw-${who.lastName.toLowerCase()}@example.test`,
      });
      const created = await createApplication(db, {
        personId,
        openingId,
        origin: "landing",
        entryChannel: "role_qr",
        actor: { type: "applicant" },
        occurredAt: new Date(Date.now() - 3_600_000),
      });
      who.applicationId = created.applicationId;
      await transition(db, { action: "submit", applicationId: created.applicationId, actor: { type: "applicant" } });
    }
    const [admin] = await db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(and(eq(schema.appUser.role, "admin"), eq(schema.appUser.status, "active")))
      .limit(1);
    doorSessionId = uuidv7();
    await db.insert(schema.groupSession).values({
      id: doorSessionId,
      openingId,
      startsAt: new Date(),
      locationName: doorLocation,
      status: "scheduled",
      createdBy: admin!.id,
    });
  });

  test.afterAll(async () => {
    if (!sql) return;
    for (const who of Object.values(people)) {
      if (who.applicationId) await sql`update application set deleted_at = now() where id = ${who.applicationId}`;
    }
    await sql`update group_session set deleted_at = now() where location_name in (${location}, ${doorLocation})`;
    await sql.end();
  });

  test("create a session, add someone from the sign-up sheet, star them on the floor and see it on their profile", async ({ page }) => {
    const sheetName = `S. ${people.sheet.lastName}`;

    // Create the session.
    await page.goto("/admin/sessions");
    await page.getByRole("button", { name: "New session" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Opening").selectOption(openingId);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    await dialog.getByLabel("Date and time").fill(local);
    await dialog.getByLabel("Location").fill(location);
    await dialog.getByRole("button", { name: "Create session" }).click();
    await expect(page).toHaveURL(/\/admin\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByText(location).first()).toBeVisible();

    // Type in a name from the sheet with the keyboard alone: Enter moves to the mobile,
    // Enter again adds the row. The mobile matches the applicant at once.
    const sheet = page.getByRole("form", { name: "Add from the sign-up sheet" });
    await sheet.getByLabel("Name as written").fill(sheetName);
    await sheet.getByLabel("Name as written").press("Enter");
    await expect(sheet.getByLabel("Mobile (optional)")).toBeFocused();
    await page.keyboard.type(`(651) ${people.sheet.mobile.slice(5, 8)}-${people.sheet.mobile.slice(8)}`);
    await page.keyboard.press("Enter");
    await expect(page.getByText(`Added ${sheetName}, matched to their application by phone.`)).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByLabel("Name as written")).toHaveValue("");
    await expect(sheet.getByLabel("Name as written")).toBeFocused();
    const row = page.getByRole("listitem", { name: sheetName });
    await expect(row.getByRole("link", { name: `${people.sheet.firstName} ${people.sheet.lastName}` })).toBeVisible();
    await expect(row.getByText("(matched by phone)")).toBeVisible();

    // Star them on the floor view, with a reason.
    await page.getByRole("link", { name: "Floor view" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Floor view" })).toBeVisible({ timeout: 30_000 });
    const card = page.getByRole("region", { name: sheetName });
    await card.getByRole("button", { name: "Star", exact: true }).click();
    await card.getByRole("radio", { name: "Engaged or asked good questions" }).click();
    await card.getByLabel("Note (optional)").fill("Asked about storm call-outs");
    await card.getByRole("button", { name: "Give star" }).click();
    await expect(card.getByRole("button", { name: "Starred" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    await expect(card.getByText("Engaged or asked good questions")).toBeVisible();

    // The star shows on their profile, with the reason, the note and who gave it.
    await page.goto(`/admin/applicants/${people.sheet.applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(people.sheet.lastName, { timeout: 30_000 });
    await expect(page.getByText("Group interview", { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`On the sign-up sheet as "${sheetName.replace(".", "\\.")}"`))).toBeVisible();
    await expect(page.getByText("Engaged or asked good questions")).toBeVisible();
    await expect(page.getByText("Asked about storm call-outs")).toBeVisible();
  });

  test("a door check-in matches an applicant on file by phone", async ({ page }) => {
    // The session starts now, so the check-in below is on time however long the first test took.
    await sql`update group_session set starts_at = now() where id = ${doorSessionId}`;
    await page.goto(`/check-in/${doorSessionId}`);
    await expect(page.getByText("Enter your name and mobile number to check in.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("We use your number only to match you with your application.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Tidepool");

    await page.getByLabel("Your name").fill(`Door ${people.door.lastName}`);
    await page.getByLabel("Your name").press("Enter");
    await expect(page.getByLabel("Mobile number")).toBeFocused();
    await page.getByLabel("Mobile number").fill(people.door.mobile.slice(2));
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText("Thanks, Door.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("You're checked in.", { exact: false })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(people.door.lastName);

    await expect
      .poll(async () => {
        const rows = await sql`select application_id, match_method, source from attendee where group_session_id = ${doorSessionId}`;
        return rows.map((r) => [r.application_id, r.match_method, r.source]);
      })
      .toEqual([[people.door.applicationId, "phone_match", "door_checkin"]]);

    // The form comes back empty for the next person after five seconds.
    await expect(page.getByLabel("Your name")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Your name")).toHaveValue("");
    await expect(page.getByLabel("Mobile number")).toHaveValue("");

    // The profile shows the check-in, and the arrival it recorded.
    await page.goto(`/admin/applicants/${people.door.applicationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(people.door.lastName, { timeout: 30_000 });
    await expect(page.getByText(/Checked in at the door at .* Matched by phone\./)).toBeVisible();
    await expect(page.getByLabel("Group interview arrival")).toHaveValue("on_time");
  });
});
