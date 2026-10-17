import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { employer, messageTemplate, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "../actor";
import { diffChanges, writeAudit } from "../audit";
import { getEmployer, type EmployerRow } from "../config/employer";
import type { Channel, MessagePurpose } from "./send";
import {
  checkTemplate,
  EDITABLE_PURPOSES,
  isEditablePurpose,
  sampleValues,
  SYSTEM_PURPOSES,
  type EditablePurpose,
  type TemplateIssue,
  type TemplateVariable,
} from "./template-text";

// Settings > Message templates (DATA_MODEL.md, message_template; content/legal/messages.md).
// Templates are not versioned: message.body keeps each message as sent, and every edit is
// audited with the old and new wording. Admins edit the Phase 2 templates; the Phase 1
// templates that go out on their own are shown read-only. The one-on-one booking link
// ({booking_link}) is edited on the same screen.

export type TemplateErrorCode = "not_found" | "read_only" | "invalid_template" | "invalid_booking_link" | "not_sendable";

export class TemplateError extends Error {
  constructor(
    readonly code: TemplateErrorCode,
    message: string,
    readonly issues: TemplateIssue[] = [],
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

type TemplateRow = typeof messageTemplate.$inferSelect;

export type TemplateItem = {
  id: string;
  purpose: MessagePurpose;
  channel: Channel;
  roleName: string | null;
  name: string;
  subject: string | null;
  body: string;
  editable: boolean;
  updatedAt: Date;
};

export type TemplateSettings = {
  brand: string;
  bookingLinkUrl: string | null;
  templates: TemplateItem[];
  sample: Record<TemplateVariable, string>;
};

const PURPOSE_ORDER: readonly MessagePurpose[] = [...EDITABLE_PURPOSES, ...SYSTEM_PURPOSES];

export async function getTemplateSettings(db: Db): Promise<TemplateSettings> {
  const emp = await getEmployer(db);
  const rows = await db
    .select({ t: messageTemplate, roleName: role.internalName })
    .from(messageTemplate)
    .leftJoin(role, eq(role.id, messageTemplate.roleId))
    .where(and(eq(messageTemplate.employerId, emp.id), isNull(messageTemplate.archivedAt)));
  const templates = rows
    .map(({ t, roleName }) => ({ ...toItem(t), roleName }))
    .sort((a, b) => rank(a) - rank(b) || (a.roleName ?? "").localeCompare(b.roleName ?? ""));
  return { brand: emp.displayName, bookingLinkUrl: emp.bookingLinkUrl, templates, sample: await samplesFor(db, emp) };
}

function rank(item: TemplateItem): number {
  const purpose = PURPOSE_ORDER.indexOf(item.purpose);
  return (purpose === -1 ? PURPOSE_ORDER.length : purpose) * 2 + (item.channel === "sms" ? 0 : 1);
}

function toItem(row: TemplateRow): TemplateItem {
  return {
    id: row.id,
    purpose: row.purpose,
    channel: row.channel,
    roleName: null,
    name: row.name,
    subject: row.subject,
    body: row.body,
    editable: isEditablePurpose(row.purpose),
    updatedAt: row.updatedAt,
  };
}

// The preview's stand-ins, with the employer's own name, help contact, booking link and first role.
async function samplesFor(db: Db, emp: EmployerRow): Promise<Record<TemplateVariable, string>> {
  const [first] = await db
    .select({ title: role.title })
    .from(role)
    .where(and(eq(role.employerId, emp.id), isNull(role.archivedAt)))
    .orderBy(asc(role.sortOrder))
    .limit(1);
  return sampleValues({
    brand: emp.displayName,
    hiringHost: emp.hiringHost,
    helpContact: emp.helpContact,
    bookingLinkUrl: emp.bookingLinkUrl,
    roleTitle: first?.title ?? null,
  });
}

export type TemplateEdit = { templateId: string; name: string; subject: string | null; body: string };

// Saves an Admin's edit after the same checks the editor shows (template-text.ts).
export async function updateTemplate(db: Db, input: TemplateEdit & { actor: Actor }): Promise<TemplateItem> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(messageTemplate).where(eq(messageTemplate.id, input.templateId)).for("update");
    if (!before || before.archivedAt) throw new TemplateError("not_found", "That template is gone. Reload the page.");
    if (!isEditablePurpose(before.purpose)) {
      throw new TemplateError("read_only", "This message goes out on its own, so its wording is not edited here.");
    }
    const [emp] = await tx.select().from(employer).where(eq(employer.id, before.employerId));
    const draft = {
      purpose: before.purpose,
      channel: before.channel,
      name: input.name,
      subject: before.channel === "email" ? input.subject : null,
      body: input.body.replace(/\r\n?/g, "\n"),
    };
    const check = checkTemplate(draft, { brand: emp!.displayName, sample: await samplesFor(tx, emp!) });
    if (check.errors.length > 0) throw new TemplateError("invalid_template", check.errors[0]!.message, check.errors);

    const [after] = await tx
      .update(messageTemplate)
      .set({ name: draft.name.trim(), subject: draft.subject?.trim() || null, body: draft.body.trim() })
      .where(eq(messageTemplate.id, before.id))
      .returning();
    const changes = diffChanges(before, after!, ["name", "subject", "body"]);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "message_template.update",
        entityType: "message_template",
        entityId: before.id,
        changes,
      });
    }
    return toItem(after!);
  });
}

// ---------------------------------------------------------------------------
// The booking link

export const BOOKING_LINK_MAX = 300;

// Blank clears it. Otherwise one https:// address of plain characters, since it goes into texts.
export function normalizeBookingLink(raw: string | null): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const invalid = (message: string) => new TemplateError("invalid_booking_link", message);
  if (value.length > BOOKING_LINK_MAX) throw invalid(`Keep the booking link under ${BOOKING_LINK_MAX} characters.`);
  if (!/^[\x21-\x7E]+$/.test(value)) {
    throw invalid("The booking link cannot have spaces or special characters. Copy it exactly as your scheduling tool shows it.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("That is not a web address. Copy the link from your scheduling tool; it starts with https://.");
  }
  if (url.protocol !== "https:") throw invalid("The booking link must start with https://.");
  if (!url.hostname.includes(".")) throw invalid("That is not a full web address. Copy the whole link from your scheduling tool.");
  return value;
}

export async function setBookingLink(db: Db, input: { actor: Actor; url: string | null }): Promise<string | null> {
  const next = normalizeBookingLink(input.url);
  return db.transaction(async (tx) => {
    const before = await getEmployer(tx);
    if (before.bookingLinkUrl === next) return next;
    await tx.update(employer).set({ bookingLinkUrl: next }).where(eq(employer.id, before.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: "employer.booking_link_update",
      entityType: "employer",
      entityId: before.id,
      changes: { bookingLinkUrl: { from: before.bookingLinkUrl, to: next } },
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// New templates (the Phase 2 db:change)

export type NewTemplate = { purpose: EditablePurpose; channel: Channel; name: string; subject?: string; body: string };

// Inserts each employer-wide template that has no live row for its purpose and channel
// yet, and leaves every existing one alone, edited or not.
export async function addMissingTemplates(
  db: Db,
  input: { actor: Actor; templates: readonly NewTemplate[] },
): Promise<{ added: NewTemplate[]; kept: NewTemplate[] }> {
  const emp = await getEmployer(db);
  const added: NewTemplate[] = [];
  const kept: NewTemplate[] = [];
  for (const template of input.templates) {
    const [existing] = await db
      .select({ id: messageTemplate.id })
      .from(messageTemplate)
      .where(
        and(
          eq(messageTemplate.employerId, emp.id),
          isNull(messageTemplate.roleId),
          eq(messageTemplate.purpose, template.purpose),
          eq(messageTemplate.channel, template.channel),
          isNull(messageTemplate.archivedAt),
        ),
      );
    if (existing) {
      kept.push(template);
      continue;
    }
    const id = uuidv7();
    const [inserted] = await db
      .insert(messageTemplate)
      .values({
        id,
        employerId: emp.id,
        roleId: null,
        purpose: template.purpose,
        channel: template.channel,
        name: template.name,
        subject: template.subject ?? null,
        body: template.body,
      })
      .onConflictDoNothing()
      .returning({ id: messageTemplate.id });
    if (!inserted) {
      kept.push(template);
      continue;
    }
    await writeAudit(db, {
      actor: input.actor,
      action: "message_template.create",
      entityType: "message_template",
      entityId: id,
      changes: { purpose: template.purpose, channel: template.channel, name: template.name },
    });
    added.push(template);
  }
  return { added, kept };
}
