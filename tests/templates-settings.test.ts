import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { runChanges } from "@/db/changes";
import { PHASE2_TEMPLATES, phase2Templates } from "@/db/changes/phase2-templates";
import { appliedChange, auditLog, employer, messageTemplate } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { EDITABLE_PURPOSES } from "@/server/services/messaging/template-text";
import { getTemplateSettings, normalizeBookingLink, setBookingLink, TemplateError, updateTemplate } from "@/server/services/messaging/templates";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadEmployer, TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { ensurePhase2Templates, liveTemplate } from "./helpers/templates";

// Settings > Message templates and the Phase 2 templates change: Admins edit the Phase 2
// wording after the messages.md checks, every edit is audited, the Phase 1 templates are
// read-only, the booking link takes https only, and the change adds what is missing and
// never overwrites what is there. Every case runs in a rolled-back transaction, so the
// shared test database keeps only the Phase 1 templates (tests/seed.test.ts counts them).

const CHANGE_ID = "2026-10-16-phase2-templates";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let adminId: string;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
  employerId = (await loadEmployer(db)).id;
});

afterAll(async () => {
  await sql.end();
});

// A rolled-back transaction with the Phase 2 templates on file.
function withTemplates(fn: (tx: Tx) => Promise<void>) {
  return withRollback(db, async (tx) => {
    await ensurePhase2Templates(tx, adminId);
    await fn(tx);
  });
}

async function captureError(run: Promise<unknown>): Promise<TemplateError> {
  const caught = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(TemplateError);
  return caught as TemplateError;
}

describe("the template list", () => {
  it("shows the Phase 2 templates first, text before email, then the Phase 1 ones read-only", async () => {
    await withTemplates(async (tx) => {
      const settings = await getTemplateSettings(tx);
      const order = settings.templates.map((t) => `${t.purpose}:${t.channel}`);
      expect(order.slice(0, 8)).toEqual(EDITABLE_PURPOSES.flatMap((p) => [`${p}:sms`, `${p}:email`]));
      expect(settings.templates.slice(0, 8).every((t) => t.editable)).toBe(true);
      const system = settings.templates.slice(8);
      expect(system.map((t) => t.purpose)).toEqual(expect.arrayContaining(["resume_link", "link_recovery", "reminder_24h", "submit_confirmation", "help_reply"]));
      expect(system.every((t) => !t.editable)).toBe(true);
      expect(settings.brand).toBe("Kahuna Window Cleaning");
      expect(settings.sample.first_name).toBe("Marcus");
      expect(settings.sample.link).toBe("https://tidepool.kahunawindowcleaning.com/r#Xq3v9TzR2mLp8sKw4bNc1A");
    });
  });
});

describe("editing a template", () => {
  it("saves an Admin's edit and audits the old and new wording", async () => {
    await withTemplates(async (tx) => {
      const before = await liveTemplate(tx, employerId, "status_update", "sms");
      const body = "Kahuna Window Cleaning: Hi {first_name}, news on your application: {link} Reply STOP to opt out.";
      const saved = await updateTemplate(tx, { actor: staffActor(adminId), templateId: before.id, name: "Status update (text)", subject: "ignored for texts", body: `  ${body}\r\n` });
      expect(saved.body).toBe(body);
      expect(saved.subject).toBeNull();
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, before.id), eq(auditLog.action, "message_template.update")));
      expect(audit!.actorUserId).toBe(adminId);
      expect(audit!.changes).toEqual({ body: { from: before.body, to: body } });

      // Saving the same wording again changes nothing and writes no audit row.
      await updateTemplate(tx, { actor: staffActor(adminId), templateId: before.id, name: saved.name, subject: null, body });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, before.id), eq(auditLog.action, "message_template.update")));
      expect(audits).toHaveLength(1);
    });
  });

  it("edits an email's subject and keeps its line breaks", async () => {
    await withTemplates(async (tx) => {
      const before = await liveTemplate(tx, employerId, "decline", "email");
      const body = "Hi {first_name},\n\nThank you for applying.\n\nKahuna Window Cleaning Hiring";
      const saved = await updateTemplate(tx, { actor: staffActor(adminId), templateId: before.id, name: before.name, subject: " Thank you, {first_name} ", body });
      expect(saved).toMatchObject({ subject: "Thank you, {first_name}", body });
    });
  });

  it("refuses wording that breaks a rule, says why, and changes nothing", async () => {
    await withTemplates(async (tx) => {
      const before = await liveTemplate(tx, employerId, "one_on_one_invite", "sms");
      const edit = (body: string) => updateTemplate(tx, { actor: staffActor(adminId), templateId: before.id, name: before.name, subject: null, body });

      const missing = await captureError(edit(before.body.replace(" {booking_link}", "")));
      expect(missing.code).toBe("invalid_template");
      expect(missing.message).toBe("The invite needs {booking_link}, so they can pick a time.");

      const unknown = await captureError(edit(before.body.replace("{first_name}", "{FirstName}")));
      expect(unknown.issues.map((i) => i.message)).toContain("{FirstName} is not a placeholder Tidepool fills in. Pick one from the list, like {first_name}.");

      const unbranded = await captureError(edit("Hi {first_name}! Book: {booking_link}"));
      expect(unbranded.issues.map((i) => i.message)).toEqual([
        'Texts start with "Kahuna Window Cleaning:" so people know who is texting.',
        'Texts end with "Reply STOP to opt out." (or the longer closing with HELP and STOP).',
      ]);
      expect((await liveTemplate(tx, employerId, "one_on_one_invite", "sms")).body).toBe(before.body);
    });
  });

  it("keeps the Phase 1 templates read-only", async () => {
    const [link] = await db
      .select()
      .from(messageTemplate)
      .where(and(eq(messageTemplate.employerId, employerId), eq(messageTemplate.purpose, "resume_link"), eq(messageTemplate.channel, "sms")));
    const error = await captureError(updateTemplate(db, { actor: staffActor(adminId), templateId: link!.id, name: link!.name, subject: null, body: link!.body }));
    expect(error.code).toBe("read_only");
    expect(error.message).toBe("This message goes out on its own, so its wording is not edited here.");
  });
});

describe("the booking link", () => {
  it("takes one https:// address, audits the change, and clears when blank", async () => {
    await withRollback(db, async (tx) => {
      expect(await setBookingLink(tx, { actor: staffActor(adminId), url: "  https://book.example.com/kahuna  " })).toBe("https://book.example.com/kahuna");
      const [row] = await tx.select({ url: employer.bookingLinkUrl }).from(employer).where(eq(employer.id, employerId));
      expect(row!.url).toBe("https://book.example.com/kahuna");
      // The same link again writes nothing.
      await setBookingLink(tx, { actor: staffActor(adminId), url: "https://book.example.com/kahuna" });
      expect(await setBookingLink(tx, { actor: staffActor(adminId), url: "" })).toBeNull();
      const audits = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, employerId), eq(auditLog.action, "employer.booking_link_update")));
      expect(audits).toHaveLength(2);
      expect(audits.map((a) => a.changes)).toEqual(
        expect.arrayContaining([
          { bookingLinkUrl: { from: null, to: "https://book.example.com/kahuna" } },
          { bookingLinkUrl: { from: "https://book.example.com/kahuna", to: null } },
        ]),
      );
    });
  });

  it("refuses anything but https", () => {
    const refusal = (raw: string) => {
      try {
        normalizeBookingLink(raw);
      } catch (error) {
        return (error as TemplateError).message;
      }
      return null;
    };
    expect(refusal("http://book.example.com/kahuna")).toBe("The booking link must start with https://.");
    expect(refusal("book.example.com/kahuna")).toBe("That is not a web address. Copy the link from your scheduling tool; it starts with https://.");
    expect(refusal("https://book example.com")).toBe(
      "The booking link cannot have spaces or special characters. Copy it exactly as your scheduling tool shows it.",
    );
    expect(refusal("https://localhost/book")).toBe("That is not a full web address. Copy the whole link from your scheduling tool.");
    expect(refusal(`https://book.example.com/${"x".repeat(300)}`)).toBe("Keep the booking link under 300 characters.");
    expect(refusal("javascript:alert(1)")).toBe("The booking link must start with https://.");
    expect(normalizeBookingLink("   ")).toBeNull();
  });
});

describe("the Phase 2 templates change", () => {
  async function live(tx: Tx) {
    return tx
      .select()
      .from(messageTemplate)
      .where(and(eq(messageTemplate.employerId, employerId), inArray(messageTemplate.purpose, [...EDITABLE_PURPOSES]), isNull(messageTemplate.archivedAt)));
  }

  it("adds the eight templates exactly as messages.md has them, once", async () => {
    await withRollback(db, async (tx) => {
      // As on a database that has never had them.
      await tx.update(messageTemplate).set({ archivedAt: new Date() }).where(inArray(messageTemplate.purpose, [...EDITABLE_PURPOSES]));
      const lines: string[] = [];
      expect(await runChanges(tx, [phase2Templates], (line) => lines.push(line))).toEqual({ applied: [CHANGE_ID], skipped: [] });
      expect(lines.join("\n")).toContain("added one_on_one_invite sms, one_on_one_invite email");

      const rows = await live(tx);
      expect(rows).toHaveLength(8);
      for (const t of PHASE2_TEMPLATES) {
        const row = rows.find((r) => r.purpose === t.purpose && r.channel === t.channel);
        expect(row, `${t.purpose} ${t.channel}`).toMatchObject({ roleId: null, name: t.name, subject: t.subject ?? null, body: t.body });
      }
      const invite = rows.find((r) => r.purpose === "one_on_one_invite" && r.channel === "sms")!;
      expect(invite.body).toBe("Kahuna Window Cleaning: Hi {first_name}, we'd like to interview you. Pick a time here: {booking_link} Reply STOP to opt out.");
      expect(rows.some((r) => r.purpose === "group_invite")).toBe(false);

      const creates = await tx.select().from(auditLog).where(and(eq(auditLog.action, "message_template.create"), inArray(auditLog.entityId, rows.map((r) => r.id))));
      expect(creates).toHaveLength(8);
      expect(creates.every((a) => a.actorUserId === adminId)).toBe(true);
      const [applied] = await tx.select().from(appliedChange).where(eq(appliedChange.id, CHANGE_ID));
      expect(applied!.description).toBe(phase2Templates.description);

      // The second run does nothing.
      expect(await runChanges(tx, [phase2Templates])).toEqual({ applied: [], skipped: [CHANGE_ID] });
      expect(await live(tx)).toHaveLength(8);
    });
  });

  it("never overwrites a template already on file, edited or not", async () => {
    await withTemplates(async (tx) => {
      // The invite text as someone edited it; the other seven not on file yet.
      const edited = "Kahuna Window Cleaning: Hi {first_name}, the owner's own words: {booking_link} Reply STOP to opt out.";
      const own = await liveTemplate(tx, employerId, "one_on_one_invite", "sms");
      await tx.update(messageTemplate).set({ body: edited }).where(eq(messageTemplate.id, own.id));
      await tx
        .update(messageTemplate)
        .set({ archivedAt: new Date() })
        .where(and(inArray(messageTemplate.purpose, [...EDITABLE_PURPOSES]), ne(messageTemplate.id, own.id)));

      const lines: string[] = [];
      await runChanges(tx, [phase2Templates], (line) => lines.push(line));
      expect(lines.join("\n")).toContain("kept as they are: one_on_one_invite sms");

      const rows = await live(tx);
      expect(rows).toHaveLength(8);
      const invite = rows.filter((r) => r.purpose === "one_on_one_invite" && r.channel === "sms");
      expect(invite).toEqual([expect.objectContaining({ id: own.id, body: edited })]);
    });
  });

  it("is listed after the snow questions, so the merged list keeps its order", async () => {
    const { CHANGES } = await import("@/db/changes");
    const ids = CHANGES.map((c) => c.id);
    expect(ids.indexOf(CHANGE_ID)).toBe(ids.indexOf("2026-10-16-snow-behavioral-questions") + 1);
  });
});
