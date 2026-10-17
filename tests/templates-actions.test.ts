import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, sql } from "@/db";
import { message, messageTemplate } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { closeWithDeclineAction, moveWithInviteAction, previewMessageAction, sendMessageAction } from "@/server/actions/admin/messages";
import { setBookingLinkAction, updateTemplateAction } from "@/server/actions/admin/templates";
import type { UserRole } from "@/server/auth/roles";
import { EDITABLE_PURPOSES } from "@/server/services/messaging/template-text";
import { loadAdminId, loadEmployer, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { BOOKING_LINK, ensurePhase2Templates, liveTemplate, readyEmployer, resetEmployer, submittedApplicant } from "./helpers/templates";

// The template and send actions check the role first: Admins edit templates and the
// booking link, Hiring Managers and Admins send, Viewers do neither. requireRole is
// replaced by one that reads the role set here; everything behind it is real.

const { signedIn } = vi.hoisted(() => ({ signedIn: { role: "admin" as UserRole, userId: "" } }));

vi.mock("@/server/auth/require-role", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/require-role")>();
  return {
    ...actual,
    requireRole: async (allowed: UserRole | readonly UserRole[]) => {
      const roles = typeof allowed === "string" ? [allowed] : allowed;
      if (!roles.includes(signedIn.role)) throw new actual.AccessDeniedError();
      return { id: signedIn.userId, email: TEST_ADMIN_EMAIL, name: null, role: signedIn.role, isDevBypass: false };
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let snow: SnowFixture;
let stages: Record<string, string>;
let employerId: string;
const created: string[] = [];
let addedTemplates: string[] = [];

async function phase2TemplateIds() {
  const rows = await db.select({ id: messageTemplate.id }).from(messageTemplate).where(inArray(messageTemplate.purpose, [...EDITABLE_PURPOSES]));
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  employerId = (await loadEmployer(db)).id;
  signedIn.userId = await loadAdminId(db);
  // The actions write through the app's own pool, so these rows really commit.
  const before = await phase2TemplateIds();
  await ensurePhase2Templates(db, signedIn.userId);
  addedTemplates = (await phase2TemplateIds()).filter((id) => !before.includes(id));
  await readyEmployer(db, employerId);
});

afterAll(async () => {
  // The shared test database keeps only the Phase 1 templates (tests/seed.test.ts counts
  // them), so this file's messages and the templates it added go again.
  if (created.length > 0) await db.delete(message).where(inArray(message.applicationId, created));
  if (addedTemplates.length > 0) await db.delete(messageTemplate).where(inArray(messageTemplate.id, addedTemplates));
  await resetEmployer(db, employerId);
  await sql.end();
});

async function applicant() {
  const a = await submittedApplicant(db, snow, employerId);
  created.push(a.applicationId);
  return a;
}

function as(role: UserRole) {
  signedIn.role = role;
}

describe("template actions", () => {
  it("let only an Admin change a template or the booking link", async () => {
    const template = await liveTemplate(db, employerId, "decline", "sms");
    const edit = { templateId: template.id, name: template.name, subject: null, body: template.body.replace("We wish you well. ", "") };

    as("hiring_manager");
    expect(await updateTemplateAction(edit)).toEqual({ ok: false, error: "Only an Admin can do this." });
    expect(await setBookingLinkAction({ url: "https://book.example.com/other" })).toEqual({ ok: false, error: "Only an Admin can do this." });
    expect((await liveTemplate(db, employerId, "decline", "sms")).body).toBe(template.body);

    as("admin");
    try {
      expect(await updateTemplateAction(edit)).toEqual({ ok: true, data: null });
      expect((await liveTemplate(db, employerId, "decline", "sms")).body).toBe(edit.body);
      const refused = await updateTemplateAction({ ...edit, body: "We won't be moving forward." });
      expect(refused).toMatchObject({ ok: false, error: 'Texts start with "Kahuna Window Cleaning:" so people know who is texting.' });
      expect(refused.ok ? [] : refused.issues).toHaveLength(2);
      expect(await setBookingLinkAction({ url: "http://book.example.com/x" })).toEqual({ ok: false, error: "The booking link must start with https://." });
    } finally {
      expect(await updateTemplateAction({ ...edit, body: template.body })).toEqual({ ok: true, data: null });
    }
  });
});

describe("send actions", () => {
  it("never let a Viewer preview, send, or move with the invite", async () => {
    const a = await applicant();
    as("viewer");
    expect(await previewMessageAction({ applicationId: a.applicationId, purpose: "status_update" })).toMatchObject({ ok: false, status: 403 });
    expect(await sendMessageAction({ applicationId: a.applicationId, purpose: "status_update", requestId: uuidv7() })).toMatchObject({ ok: false, status: 403 });
    expect(await moveWithInviteAction({ applicationId: a.applicationId, expectedSeq: 2, toStageId: stages.one_on_one_invited! })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await db.select().from(message).where(eq(message.applicationId, a.applicationId))).toHaveLength(0);
  });

  it("let a Hiring Manager send a message and move with the invite", async () => {
    const a = await applicant();
    as("hiring_manager");
    const preview = await previewMessageAction({ applicationId: a.applicationId, purpose: "one_on_one_invite" });
    expect(preview).toMatchObject({ ok: true, data: { channel: "sms", problem: null } });

    const sent = await sendMessageAction({ applicationId: a.applicationId, purpose: "status_update", requestId: uuidv7() });
    expect(sent).toMatchObject({ ok: true, data: { channel: "sms" } });

    const moved = await moveWithInviteAction({ applicationId: a.applicationId, expectedSeq: 2, toStageId: stages.one_on_one_invited! });
    expect(moved).toMatchObject({ ok: true, data: { stageId: stages.one_on_one_invited, eventSeq: 3 } });
    const rows = await db.select().from(message).where(eq(message.applicationId, a.applicationId));
    expect(rows.map((r) => r.purpose).sort()).toEqual(["one_on_one_invite", "status_update"]);
    expect(rows.find((r) => r.purpose === "one_on_one_invite")!.body).toContain(BOOKING_LINK);

    // A stale version is refused like any move, and queues nothing.
    expect(await moveWithInviteAction({ applicationId: a.applicationId, expectedSeq: 2, toStageId: stages.one_on_one_invited! })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("refuse a decline on a withdrawal before anything is written", async () => {
    const a = await applicant();
    as("admin");
    const result = await closeWithDeclineAction({
      applicationId: a.applicationId,
      expectedSeq: 2,
      outcome: "withdrew" as "disqualified",
      reasonOptionId: uuidv7(),
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_input" });
  });
});
