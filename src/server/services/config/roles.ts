import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { formItem, formVersion, opening, picklistOption, pipelineStage, question, questionVersion, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { writeAudit } from "@/server/services/audit";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors";
import { milestoneOrderProblem, type RoleRow } from "./stages";

// Settings > Roles and stages > New role (PLAN.md, Phase 2: "From this point you add a
// role yourself"). A new role is a copy of another, made in one transaction: its live
// pipeline stages, its role-scoped picklist options (such as the ladder test and its
// disqualify reason) and, unless the Admin leaves them out, its current questions as
// version 1 of the new role's form, a draft. Each question becomes a new lineage owned
// by the new role, with the same key, wording, choices and their keys, staff guidance,
// starting-word check and never-send flag, so the draft publishes through the question
// editor like any other. The questions come from the role's live form, or its draft
// when nothing is published yet. No rubric, so scoring is off, and no opening: the
// role's page adds a draft opening, and Settings > Openings sets its pay and dates and
// opens it. Everything is audited.

export type RoleErrorCode =
  | "role_not_found"
  | "invalid_input"
  | "role_key_exists"
  | "role_name_taken"
  | "template_incomplete"
  | "opening_key_exists";

export class RoleError extends Error {
  constructor(
    readonly code: RoleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoleError";
  }
}

export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const OPENING_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME_MAX_LENGTH = 120;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type FormVersionRow = typeof formVersion.$inferSelect;

function cleanText(value: string, what: string): string {
  const text = value.trim();
  if (!text) throw new RoleError("invalid_input", `Enter the ${what}`);
  if (text.length > NAME_MAX_LENGTH) throw new RoleError("invalid_input", `Keep the ${what} under ${NAME_MAX_LENGTH} characters`);
  return text;
}

function cleanRoleKey(value: string): string {
  const key = value.trim();
  if (!ROLE_KEY_PATTERN.test(key)) {
    throw new RoleError("invalid_input", "The key is 2 to 40 lowercase letters, digits and underscores, starting with a letter");
  }
  return key;
}

// The form a copy takes its questions from: the live one, else the draft.
async function sourceForm(db: Db, roleId: string): Promise<FormVersionRow | null> {
  const forms = await db
    .select()
    .from(formVersion)
    .where(and(eq(formVersion.roleId, roleId), inArray(formVersion.status, ["published", "draft"])))
    .orderBy(desc(formVersion.version));
  return forms.find((f) => f.status === "published") ?? forms.find((f) => f.status === "draft") ?? null;
}

export type RoleCopyPreview = {
  roleId: string;
  stages: number;
  picklistOptions: number;
  questions: number;
  form: { version: number; status: "published" | "draft" } | null;
};

// What New role copies from each role, shown beside the role picker.
export async function previewRoleCopies(db: Db): Promise<RoleCopyPreview[]> {
  const roles = await db.select({ id: role.id }).from(role).where(isNull(role.archivedAt)).orderBy(asc(role.sortOrder));
  const previews: RoleCopyPreview[] = [];
  for (const r of roles) {
    const [stages] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pipelineStage)
      .where(and(eq(pipelineStage.roleId, r.id), isNull(pipelineStage.archivedAt)));
    const [options] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(picklistOption)
      .where(and(eq(picklistOption.roleId, r.id), isNull(picklistOption.archivedAt)));
    const form = await sourceForm(db, r.id);
    const [items] = form
      ? await db.select({ n: sql<number>`count(*)::int` }).from(formItem).where(eq(formItem.formVersionId, form.id))
      : [{ n: 0 }];
    previews.push({
      roleId: r.id,
      stages: Number(stages?.n ?? 0),
      picklistOptions: Number(options?.n ?? 0),
      questions: Number(items?.n ?? 0),
      form: form ? { version: form.version, status: form.status as "published" | "draft" } : null,
    });
  }
  return previews;
}

export type CreateRoleInput = {
  actor: Actor;
  // The role to copy.
  templateRoleId: string;
  // Applicant-facing.
  title: string;
  // Staff-facing.
  internalName: string;
  key: string;
  // Default true: copy the template's current questions into a draft form.
  copyQuestions?: boolean;
  now?: Date;
};

export type CreateRoleResult = {
  roleId: string;
  stages: number;
  picklistOptions: number;
  questions: number;
  // The new role's draft form, or null when no questions were copied.
  formVersionId: string | null;
};

export async function createRoleFromTemplate(db: Db, input: CreateRoleInput): Promise<CreateRoleResult> {
  const title = cleanText(input.title, "job title applicants see");
  const internalName = cleanText(input.internalName, "name staff see");
  const key = cleanRoleKey(input.key);
  const now = input.now ?? new Date();
  const createdBy = input.actor.type === "staff" ? input.actor.userId : null;

  return db.transaction(async (tx) => {
    const [template] = await tx.select().from(role).where(and(eq(role.id, input.templateRoleId), isNull(role.archivedAt)));
    if (!template) throw new RoleError("role_not_found", "Pick the role to copy");
    const [sameName] = await tx
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.employerId, template.employerId), isNull(role.archivedAt), sql`lower(${role.internalName}) = lower(${internalName})`));
    if (sameName) throw new RoleError("role_name_taken", `Another role is already called "${internalName}"`);

    const [top] = await tx.select({ sortOrder: max(role.sortOrder) }).from(role).where(eq(role.employerId, template.employerId));
    const roleId = uuidv7();
    try {
      await tx.insert(role).values({
        id: roleId,
        employerId: template.employerId,
        key,
        internalName,
        title,
        summary: null,
        usesGroupInterview: template.usesGroupInterview,
        sortOrder: (top?.sortOrder ?? 0) + 10,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new RoleError("role_key_exists", `Another role already uses the key ${key}`);
      throw error;
    }

    // 1. The live stages, keys, milestones and board flags included.
    const stages = await tx
      .select()
      .from(pipelineStage)
      .where(and(eq(pipelineStage.roleId, template.id), isNull(pipelineStage.archivedAt)))
      .orderBy(asc(pipelineStage.sortOrder));
    const systemMilestones = new Set(stages.filter((s) => s.isSystem).map((s) => s.milestone));
    if (!systemMilestones.has("started") || !systemMilestones.has("submitted") || !stages.some((s) => s.milestone === "hired")) {
      throw new RoleError("template_incomplete", "That role's pipeline is missing Started, Submitted or Hired, so it cannot be copied");
    }
    if (milestoneOrderProblem(stages)) throw new RoleError("template_incomplete", "That role's stages are out of milestone order, so it cannot be copied");
    await tx.insert(pipelineStage).values(
      stages.map((s) => ({
        id: uuidv7(),
        roleId,
        key: s.key,
        name: s.name,
        publicLabel: s.publicLabel,
        milestone: s.milestone,
        sortOrder: s.sortOrder,
        isSystem: s.isSystem,
        showOnBoard: s.showOnBoard,
        createdAt: now,
        updatedAt: now,
      })),
    );

    // 2. The picklist options that belong to the template alone. Options for every role
    //    already apply to the new one.
    const options = await tx
      .select()
      .from(picklistOption)
      .where(and(eq(picklistOption.roleId, template.id), isNull(picklistOption.archivedAt)))
      .orderBy(asc(picklistOption.listKey), asc(picklistOption.sortOrder));
    if (options.length > 0) {
      await tx.insert(picklistOption).values(
        options.map((o) => ({
          id: uuidv7(),
          listKey: o.listKey,
          employerId: o.employerId,
          roleId,
          key: o.key,
          label: o.label,
          requiresNote: o.requiresNote,
          fcraAdverse: o.fcraAdverse,
          defaultSeparation: o.defaultSeparation,
          sortOrder: o.sortOrder,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    // 3. The questions, as a draft form.
    const form = input.copyQuestions === false ? null : await sourceForm(tx, template.id);
    let formVersionId: string | null = null;
    let questions = 0;
    if (form) {
      formVersionId = uuidv7();
      await tx.insert(formVersion).values({
        id: formVersionId,
        roleId,
        version: 1,
        status: "draft",
        sections: form.sections,
        aiDisclosureVersionId: form.aiDisclosureVersionId,
        changeReason: null,
        createdBy,
        createdAt: now,
      });
      questions = await copyQuestions(tx, form.id, formVersionId, roleId, createdBy, now);
      await writeAudit(tx, {
        actor: input.actor,
        action: "form.draft_create",
        entityType: "form_version",
        entityId: formVersionId,
        changes: { version: 1, copiedFromRoleId: template.id, copiedFromFormVersionId: form.id, copiedFromVersion: form.version, items: questions },
        occurredAt: now,
      });
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: "role.create",
      entityType: "role",
      entityId: roleId,
      changes: {
        key: { from: null, to: key },
        internalName: { from: null, to: internalName },
        title: { from: null, to: title },
        copiedFrom: { roleId: template.id, key: template.key },
        stages: stages.map((s) => s.key),
        picklistOptions: options.map((o) => `${o.listKey}:${o.key}`),
        questions,
        formVersionId,
      },
      occurredAt: now,
    });
    return { roleId, stages: stages.length, picklistOptions: options.length, questions, formVersionId };
  });
}

// One new lineage per item of the source form: version 1, never published, with the
// wording, choices (keys kept, so attention values still match), validation, staff
// guidance and starting-word check of the version the source form holds.
async function copyQuestions(tx: Tx, fromFormVersionId: string, toFormVersionId: string, roleId: string, createdBy: string | null, now: Date): Promise<number> {
  const items = await tx
    .select({ item: formItem, version: questionVersion, lineage: question })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(eq(formItem.formVersionId, fromFormVersionId))
    .orderBy(asc(formItem.sortOrder), asc(question.key));
  for (const { item, version, lineage } of items) {
    const questionId = uuidv7();
    const questionVersionId = uuidv7();
    await tx.insert(question).values({ id: questionId, roleId, key: lineage.key, aiNeverSend: lineage.aiNeverSend, createdAt: now, updatedAt: now });
    await tx.insert(questionVersion).values({
      id: questionVersionId,
      questionId,
      version: 1,
      type: version.type,
      prompt: version.prompt,
      help: version.help,
      options: version.options,
      validation: version.validation,
      meaningChanged: false,
      changeNote: null,
      staffGuidance: version.staffGuidance,
      startsWithCheck: version.startsWithCheck,
      publishedAt: null,
      createdBy,
      createdAt: now,
    });
    await tx.insert(formItem).values({
      formVersionId: toFormVersionId,
      questionVersionId,
      sectionKey: item.sectionKey,
      sortOrder: item.sortOrder,
      required: item.required,
      attentionValues: item.attentionValues,
    });
  }
  return items.length;
}

// ---------------------------------------------------------------------------
// The roles index and a role's openings

export type RoleSummary = RoleRow & {
  stageCount: number;
  openings: { id: string; name: string; status: "draft" | "open" | "closed" }[];
  form: { published: number | null; draft: number | null };
};

export async function listRoleSummaries(db: Db): Promise<RoleSummary[]> {
  const roles = await db.select().from(role).where(isNull(role.archivedAt)).orderBy(asc(role.sortOrder), asc(role.internalName));
  if (roles.length === 0) return [];
  const ids = roles.map((r) => r.id);
  const [stageCounts, openings, forms] = await Promise.all([
    db
      .select({ roleId: pipelineStage.roleId, n: sql<number>`count(*)::int` })
      .from(pipelineStage)
      .where(and(inArray(pipelineStage.roleId, ids), isNull(pipelineStage.archivedAt)))
      .groupBy(pipelineStage.roleId),
    db
      .select({ id: opening.id, roleId: opening.roleId, name: opening.name, status: opening.status })
      .from(opening)
      .where(inArray(opening.roleId, ids))
      .orderBy(desc(opening.createdAt)),
    db
      .select({ roleId: formVersion.roleId, version: formVersion.version, status: formVersion.status })
      .from(formVersion)
      .where(and(inArray(formVersion.roleId, ids), inArray(formVersion.status, ["published", "draft"]))),
  ]);
  return roles.map((r) => ({
    ...r,
    stageCount: Number(stageCounts.find((c) => c.roleId === r.id)?.n ?? 0),
    openings: openings.filter((o) => o.roleId === r.id).map(({ id, name, status }) => ({ id, name, status })),
    form: {
      published: forms.find((f) => f.roleId === r.id && f.status === "published")?.version ?? null,
      draft: forms.find((f) => f.roleId === r.id && f.status === "draft")?.version ?? null,
    },
  }));
}

export type RoleOpening = { id: string; key: string; name: string; status: "draft" | "open" | "closed"; opensOn: string | null; payText: string | null };

export async function listRoleOpenings(db: Db, roleId: string): Promise<RoleOpening[]> {
  return db
    .select({ id: opening.id, key: opening.key, name: opening.name, status: opening.status, opensOn: opening.opensOn, payText: opening.payText })
    .from(opening)
    .where(eq(opening.roleId, roleId))
    .orderBy(desc(opening.createdAt));
}

// A new opening for a role, as a draft with no dates or pay. Settings > Openings sets
// those and opens it, with its rules (pay text and an opens-on date first, one open
// opening per role).
export async function addOpening(db: Db, input: { actor: Actor; roleId: string; name: string; key: string; now?: Date }): Promise<{ openingId: string }> {
  const name = cleanText(input.name, "opening name");
  const key = input.key.trim();
  if (!OPENING_KEY_PATTERN.test(key)) {
    throw new RoleError("invalid_input", "The key is 2 to 40 lowercase letters, digits and dashes, like gutters-2027");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [roleRow] = await tx.select({ id: role.id }).from(role).where(and(eq(role.id, input.roleId), isNull(role.archivedAt)));
    if (!roleRow) throw new RoleError("role_not_found", "No such role");
    const id = uuidv7();
    try {
      await tx.insert(opening).values({ id, roleId: roleRow.id, key, name, status: "draft", createdAt: now, updatedAt: now });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new RoleError("opening_key_exists", `This role already has an opening with the key ${key}`);
      throw error;
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "opening.create",
      entityType: "opening",
      entityId: id,
      changes: { roleId: { from: null, to: roleRow.id }, key: { from: null, to: key }, name: { from: null, to: name }, status: { from: null, to: "draft" } },
      occurredAt: now,
    });
    return { openingId: id };
  });
}
