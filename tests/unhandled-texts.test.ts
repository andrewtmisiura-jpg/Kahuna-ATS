import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { attentionCounts, listApplications, loadProfile } from "@/server/services/applications/queries";
import { createApplication, transition } from "@/server/services/applications/transition";
import { countUnhandledInbound, listUnhandledInbound, markHandled } from "@/server/services/messaging/inbox";
import { createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// One rule for "unhandled text" (PLAN.md, pushing back 3): the list's attention
// strip, the list row, the profile and the inbox all count inbound texts nobody
// marked handled and the purge has not stripped, and the profile's "Mark handled"
// is the inbox service's markHandled, so marking one text moves every count.

const TAG = "Qzunhandled";

let snow: SnowFixture;
let adminId: string;
let applicationId: string;
let personId: string;
const ids: Record<string, string> = {};

async function inbound(name: string, values: Partial<typeof message.$inferInsert>) {
  const id = uuidv7();
  await db.insert(message).values({
    id,
    direction: "inbound",
    channel: "sms",
    personId,
    applicationId,
    toAddress: "+17632922259",
    fromAddress: "+16125550188",
    body: `text ${name}`,
    status: "received",
    provider: "quo",
    providerMessageId: `quo-${id}`,
    triggeredByType: "applicant",
    ...values,
  });
  ids[name] = id;
  return id;
}

async function counts() {
  const [inbox, strip, page, profile, scoped] = await Promise.all([
    countUnhandledInbound(db),
    attentionCounts(db, snow.openingId),
    listApplications(db, { openingId: snow.openingId, search: TAG }, "admin"),
    loadProfile(db, applicationId, "admin"),
    countUnhandledInbound(db, { applicationId, personId }),
  ]);
  return { inbox, strip: strip.unhandledTexts, row: page.rows.find((r) => r.id === applicationId)!.unhandledTexts, profile: profile!.unhandledTexts, scoped };
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
  personId = await createPerson(db, { lastName: `Texter${TAG}` });
  ({ applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: { type: "applicant" },
  }));
  await transition(db, { action: "submit", applicationId, actor: { type: "applicant" } });
});

afterAll(async () => {
  await sql.end();
});

describe("unhandled texts", () => {
  it("the strip, the row, the profile and the inbox read the same rule", async () => {
    const before = await counts();
    expect(before.strip).toBe(before.inbox);
    expect(before).toMatchObject({ row: 0, profile: 0, scoped: 0 });

    // Counted: filed to the application, and filed to the person with no application.
    await inbound("filed", {});
    await inbound("personOnly", { applicationId: null });
    // Not counted: already handled, an outbound text, and one the purge stripped.
    await inbound("handled", { handledAt: new Date(), handledBy: adminId });
    await inbound("outbound", { direction: "outbound", status: "sent", triggeredByType: "staff", triggeredByUserId: adminId });
    await inbound("stripped", { redactedAt: new Date(), toAddress: null, fromAddress: null, body: null });

    const after = await counts();
    expect(after.inbox).toBe(before.inbox + 2);
    expect(after.strip).toBe(after.inbox);
    expect(after).toMatchObject({ row: 2, profile: 2, scoped: 2 });

    const listed = (await listUnhandledInbound(db)).map((item) => item.messageId);
    expect(listed).toEqual(expect.arrayContaining([ids.filed, ids.personOnly]));
    expect(listed).not.toContain(ids.stripped);
    expect(listed).not.toContain(ids.handled);

    // The profile thread shows both counted texts with a Mark handled button.
    const profile = (await loadProfile(db, applicationId, "admin"))!;
    const unhandledShown = profile.messages.filter((m) => m.direction === "inbound" && !m.handledAt).map((m) => m.id);
    expect(unhandledShown).toEqual(expect.arrayContaining([ids.filed, ids.personOnly]));
  });

  it("marking one handled moves every count together, once", async () => {
    const before = await counts();
    expect(await markHandled(db, ids.filed!, adminId)).toBe(true);
    expect(await markHandled(db, ids.filed!, adminId)).toBe(false);
    const after = await counts();
    expect(after).toEqual({
      inbox: before.inbox - 1,
      strip: before.strip - 1,
      row: before.row - 1,
      profile: before.profile - 1,
      scoped: before.scoped - 1,
    });
    // An outbound message can never be marked handled.
    expect(await markHandled(db, ids.outbound!, adminId)).toBe(false);
  });
});
