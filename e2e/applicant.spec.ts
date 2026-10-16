import { expect, test, type Page } from "@playwright/test";
import { and, desc, eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { message } from "@/db/schema";
import { mintResumeToken } from "@/server/services/tokens";

// The applicant flow on a phone: landing to /apply, an answer saved, a resume
// from the /r link on a fresh session, the rest of the form, submit, status page.
// The dev server sends through the sink provider, whose stored message bodies keep
// the {link:<token id>} placeholder, so the test finds the application through the
// message row addressed to the applicant and mints a link for it the way a send does.
// The snow form is the one `pnpm db:changes` publishes (Oct 16): Basics, Availability,
// Experience and the owner's "How you work" section, then Send. Run `pnpm db:changes`
// against the dev database first.

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
const mobile = `6125${run.slice(-6)}`;
const email = `e2e.${run}@example.test`;

test.afterAll(async () => {
  await sql.end();
});

async function resumeLinkFor(address: string): Promise<string> {
  const [row] = await db
    .select({ applicationId: message.applicationId })
    .from(message)
    .where(and(eq(message.toAddress, address), eq(message.purpose, "resume_link")))
    .orderBy(desc(message.createdAt))
    .limit(1);
  if (!row?.applicationId) throw new Error("no resume_link message for the applicant");
  const minted = await mintResumeToken(db, { applicationId: row.applicationId, issuedVia: "message" });
  return `/r#${minted.token}`;
}

function yesNo(page: Page, prompt: string | RegExp) {
  return page.getByRole("radiogroup", { name: prompt });
}

test("landing to submit with a resume from the link in between", async ({ page }) => {
  await page.goto("/q/SNW26QR");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Snow Removal Technician");
  await expect(page.getByText("Any background check happens only after a conditional job offer.")).toBeVisible();

  await page.getByLabel("First name").fill("Ana");
  await page.getByLabel("Last name").fill("Lind");
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByLabel("Email", { exact: true }).fill(email);
  const consent = page.getByLabel(/Text me my application link/);
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.getByRole("button", { name: "Start my application" }).click();

  // A full page load into the application.
  await page.waitForURL(/\/apply$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Basics");

  await yesNo(page, "Are you 18 or older?").getByText("Yes").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByLabel("What is the earliest date you could start?").fill("2026-11-02");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5_000 });

  // The same link on a fresh session reopens the saved answers.
  const link = await resumeLinkFor(email);
  await page.context().clearCookies();
  await page.goto("/apply");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("expired");
  await page.goto(link);
  await page.waitForURL(/\/apply$/);
  expect(page.url()).not.toContain("#");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
  await expect(yesNo(page, "Are you 18 or older?").getByRole("radio", { name: "Yes" })).toBeChecked();
  await expect(page.getByLabel("What is the earliest date you could start?")).toHaveValue("2026-11-02");

  // Continue: the rest of Basics, then Availability and Experience.
  await yesNo(page, "Do you have a valid driver's license?").getByText("Yes").click();
  await yesNo(page, "Can you get to job sites around the Twin Cities on short notice, including overnight?").getByText("Yes").click();
  await yesNo(page, /This job means shoveling/).getByText("Yes").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Availability");
  await page.getByRole("group", { name: /When could you take a snow call/ }).getByLabel("Overnight (midnight to 5am)").check();
  await page.getByRole("group", { name: /When could you take a snow call/ }).getByLabel("Weekends").check();
  await page.getByRole("radiogroup", { name: /how quickly could you be on your way/ }).getByLabel("Within 30 minutes").check();
  await page.getByRole("radiogroup", { name: /Do you have another job/ }).getByLabel("No other job").check();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Experience");
  await page.getByRole("group", { name: /Which of these have you used/ }).getByLabel("Shovel").check();
  await page.getByLabel("Your most recent job: who was the employer?").fill("Acme Snow");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // The owner's five questions, all required long answers.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("How you work");
  await expect(page.getByText("A few sentences is plenty. Spelling and grammar don't matter.")).toBeVisible();
  await page.getByLabel(/couldn't make it to a shift or commitment/).fill("I had the flu last March and called my lead the night before.");
  await page.getByLabel(/a mistake you made at work that nobody else noticed/).fill("I mislabeled a delivery and told my manager the next morning.");
  await page.getByLabel(/hardest physical job you've done/).fill("Roofing for two summers. Heat and heavy bundles. I stayed both seasons.");
  // The instruction is plain text in the prompt.
  await page.getByLabel(/Start your answer with the word 'Blue\.'/).fill("Blue. My best boss showed up first and stayed last.");
  await page.getByLabel(/forgot equipment you need to finish/).fill("Tell the customer, finish what I can, keep calling and texting my manager.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Send");
  await page.getByLabel("How did you hear about us? (optional)").selectOption("indeed");
  await page.getByRole("button", { name: "Send my application" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We got it");

  // The link now opens the status page.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your application");
  await expect(page.getByText("Received", { exact: true })).toBeVisible();
  await expect(page.getByText("We have your application.")).toBeVisible();
  await expect(page.getByText(/^Submitted /)).toBeVisible();
});

test("required questions are checked only at submit", async ({ page }) => {
  const other = `6126${run.slice(-6)}`;
  await page.goto("/q/SNW26MSG");
  await page.getByLabel("First name").fill("Ben");
  await page.getByLabel("Last name").fill("Lind");
  await page.getByLabel("Mobile number").fill(other);
  await page.getByLabel("Email", { exact: true }).fill(`e2e.${run}.b@example.test`);
  await page.getByRole("button", { name: "Start my application" }).click();
  await page.waitForURL(/\/apply$/);

  // Nothing complains while moving through unanswered screens (four sections, then Send).
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("This one is required")).toHaveCount(0);
  await page.getByRole("button", { name: "Send my application" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Basics");
  await expect(page.getByText("This one is required").first()).toBeVisible();
});

test("public pages carry the applicant headers and unknown codes are plain", async ({ page, request }) => {
  const response = await request.get("/privacy");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(response.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
  expect(response.headers()["content-security-policy"]).toContain("frame-src 'none'");

  const landing = await request.get("/q/SNW26QR");
  expect(landing.headers()["content-security-policy"]).toContain("frame-src https://challenges.cloudflare.com");

  await page.goto("/q/NOPE11");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link is not active.");

  await page.goto("/lost-link");
  await page.getByLabel("Mobile number").fill("6125550199");
  await page.getByLabel("Email", { exact: true }).fill("nobody@example.test");
  await page.getByRole("button", { name: "Send my link" }).click();
  await expect(page.getByText("If we have an application for you, your link is on its way.")).toBeVisible();
});
