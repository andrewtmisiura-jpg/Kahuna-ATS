import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  employer,
  entryCode,
  formItem,
  formVersion,
  legalTextVersion,
  messageTemplate,
  MILESTONES,
  opening,
  picklistOption,
  pipelineStage,
  question,
  questionVersion,
  role,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { ensureAdminUser } from "@/server/services/users";
import { seedLegalTexts, type LegalTextKind } from "./legal-text";
import { draftValues, ownerInput } from "./owner-input";
import { seedPicklists } from "./picklists";
import { seedPipelines, type SeedStage } from "./pipelines";
import { snowForm, windowForm, type SeedForm } from "./questions";
import { seedTemplates } from "./templates";

// The one-time Phase 1 seed (DATA_MODEL.md, "db:seed" and "Seed data for Phase 1").
// Every row is looked up by its natural key first and inserted only when missing,
// so re-running is a no-op. Published rows are never updated: the immutability
// trigger would reject that anyway. Everything runs in one transaction.

export type SeedOptions = { adminEmail: string };

export type SeedReport = {
  // Rows inserted per table on this run; all zero on a re-run.
  created: Record<string, number>;
  // ownerInput paths still carrying the DRAFT mark.
  drafts: string[];
};

type RoleKey = keyof typeof seedPipelines;

const seedRoles: Array<{
  key: RoleKey;
  internalName: string;
  title: string;
  usesGroupInterview: boolean;
  sortOrder: number;
}> = [
  {
    key: "snow_removal_tech",
    internalName: "Snow Removal Technician (on-call)",
    title: "Snow Removal Technician (on-call)",
    // PLAN.md: snow runs group interviews this fall (the data model's seed table still says false).
    usesGroupInterview: true,
    sortOrder: 10,
  },
  {
    key: "window_cleaning_tech",
    internalName: "Window Cleaning Technician (full-time seasonal)",
    title: "Window Cleaning Technician (full-time seasonal)",
    usesGroupInterview: true,
    sortOrder: 20,
  },
];

const seedForms: Record<RoleKey, SeedForm> = {
  snow_removal_tech: snowForm,
  window_cleaning_tech: windowForm,
};

export const LAUNCH_ENTRY_CODES = {
  snowRoleQr: "SNW26QR",
  snowIndeedMessage: "SNW26MSG",
} as const;

export async function seedPhase1(db: Db, options: SeedOptions): Promise<SeedReport> {
  const adminEmail = options.adminEmail?.trim();
  if (!adminEmail) {
    throw new Error("ADMIN_EMAIL is required: the seed creates the first Admin account from it");
  }

  const created: Record<string, number> = {};
  const bump = (table: string) => {
    created[table] = (created[table] ?? 0) + 1;
  };
  const now = new Date();

  await db.transaction(async (tx) => {
    const employerId = await seedEmployer(tx, bump);

    const admin = await ensureAdminUser(tx, adminEmail);
    if (admin.created) bump("app_user");

    const roleIds = {} as Record<RoleKey, string>;
    for (const def of seedRoles) {
      roleIds[def.key] = await seedRole(tx, employerId, def, bump);
      await seedStages(tx, roleIds[def.key], seedPipelines[def.key], bump);
    }

    await seedPicklistOptions(tx, employerId, roleIds, bump);
    const legalTextIds = await seedLegalTextVersions(tx, employerId, now, bump);
    await seedMessageTemplates(tx, employerId, bump);

    for (const def of seedRoles) {
      await seedForm(tx, roleIds[def.key], seedForms[def.key], legalTextIds.ai_disclosure, now, bump);
    }

    const snowOpeningId = await seedOpenings(tx, roleIds, bump);
    await seedEntryCodes(tx, roleIds.snow_removal_tech, snowOpeningId, bump);
  });

  return { created, drafts: draftValues() };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Bump = (table: string) => void;

async function seedEmployer(tx: Tx, bump: Bump): Promise<string> {
  const existing = await tx.select({ id: employer.id }).from(employer).where(eq(employer.key, "kahuna"));
  if (existing[0]) return existing[0].id;

  const { hiringEmail } = ownerInput.employer;
  const id = uuidv7();
  await tx.insert(employer).values({
    id,
    key: "kahuna",
    legalName: ownerInput.employer.legalName,
    displayName: "Kahuna Window Cleaning",
    websiteUrl: ownerInput.employer.websiteUrl,
    hiringHost: "tidepool.kahunawindowcleaning.com",
    emailFromName: "Kahuna Window Cleaning Hiring",
    emailFromAddress: ownerInput.employer.emailFromAddress,
    replyToAddress: ownerInput.employer.replyToAddress,
    // Filled by quo:connect once the API key is in Railway; no text goes out while null.
    smsQuoPhoneNumberId: null,
    smsEnabled: true,
    smsFromE164: "+17632922259",
    dailySendCap: 200,
    helpContact: hiringEmail ? `763-292-2259 (call or text) or ${hiringEmail}` : "763-292-2259 (call or text)",
    timezone: "America/Chicago",
  });
  bump("employer");
  return id;
}

async function seedRole(tx: Tx, employerId: string, def: (typeof seedRoles)[number], bump: Bump): Promise<string> {
  const existing = await tx
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.employerId, employerId), eq(role.key, def.key)));
  if (existing[0]) return existing[0].id;

  const id = uuidv7();
  await tx.insert(role).values({
    id,
    employerId,
    key: def.key,
    internalName: def.internalName,
    title: def.title,
    usesGroupInterview: def.usesGroupInterview,
    sortOrder: def.sortOrder,
  });
  bump("role");
  return id;
}

// Milestones must not decrease as sort order increases (seed validation now, the
// Phase 2 stage editor later).
export function assertMilestoneOrder(stages: readonly SeedStage[]) {
  let last = -1;
  for (const stage of [...stages].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const index = MILESTONES.indexOf(stage.milestone);
    if (index < last) {
      throw new Error(`Stage ${stage.key} has milestone ${stage.milestone}, which is earlier than the stage before it`);
    }
    last = index;
  }
}

async function seedStages(tx: Tx, roleId: string, stages: readonly SeedStage[], bump: Bump) {
  assertMilestoneOrder(stages);
  for (const stage of stages) {
    const existing = await tx
      .select({ id: pipelineStage.id })
      .from(pipelineStage)
      .where(and(eq(pipelineStage.roleId, roleId), eq(pipelineStage.key, stage.key)));
    if (existing[0]) continue;
    await tx.insert(pipelineStage).values({ id: uuidv7(), roleId, ...stage });
    bump("pipeline_stage");
  }
}

async function seedPicklistOptions(tx: Tx, employerId: string, roleIds: Record<RoleKey, string>, bump: Bump) {
  const sortOrders: Record<string, number> = {};
  for (const option of seedPicklists) {
    const sortOrder = (sortOrders[option.listKey] = (sortOrders[option.listKey] ?? 0) + 10);
    const roleId = option.roleKey ? roleIds[option.roleKey] : null;
    const existing = await tx
      .select({ id: picklistOption.id })
      .from(picklistOption)
      .where(
        and(
          eq(picklistOption.listKey, option.listKey),
          eq(picklistOption.employerId, employerId),
          roleId ? eq(picklistOption.roleId, roleId) : isNull(picklistOption.roleId),
          eq(picklistOption.key, option.key),
        ),
      );
    if (existing[0]) continue;
    await tx.insert(picklistOption).values({
      id: uuidv7(),
      listKey: option.listKey,
      employerId,
      roleId,
      key: option.key,
      label: option.label,
      requiresNote: option.requiresNote ?? false,
      fcraAdverse: option.fcraAdverse ?? false,
      defaultSeparation: option.defaultSeparation ?? null,
      sortOrder,
    });
    bump("picklist_option");
  }
}

async function seedLegalTextVersions(tx: Tx, employerId: string, now: Date, bump: Bump) {
  const ids = {} as Record<LegalTextKind, string>;
  for (const text of seedLegalTexts()) {
    const existing = await tx
      .select({ id: legalTextVersion.id })
      .from(legalTextVersion)
      .where(
        and(eq(legalTextVersion.employerId, employerId), eq(legalTextVersion.kind, text.kind), eq(legalTextVersion.version, 1)),
      );
    if (existing[0]) {
      ids[text.kind] = existing[0].id;
      continue;
    }
    const id = uuidv7();
    await tx.insert(legalTextVersion).values({
      id,
      employerId,
      kind: text.kind,
      version: 1,
      body: text.body,
      changeNote: text.changeNote,
      // Published by the seed so the pages and the consent record can point at v1.
      publishedAt: now,
      publishedBy: null,
    });
    ids[text.kind] = id;
    bump("legal_text_version");
  }
  return ids;
}

async function seedMessageTemplates(tx: Tx, employerId: string, bump: Bump) {
  for (const template of seedTemplates) {
    const existing = await tx
      .select({ id: messageTemplate.id })
      .from(messageTemplate)
      .where(
        and(
          eq(messageTemplate.employerId, employerId),
          isNull(messageTemplate.roleId),
          eq(messageTemplate.purpose, template.purpose),
          eq(messageTemplate.channel, template.channel),
          isNull(messageTemplate.archivedAt),
        ),
      );
    if (existing[0]) continue;
    await tx.insert(messageTemplate).values({
      id: uuidv7(),
      employerId,
      roleId: null,
      purpose: template.purpose,
      channel: template.channel,
      name: template.name,
      subject: template.subject ?? null,
      body: template.body,
    });
    bump("message_template");
  }
}

// Question lineages, version 1 of each, and form version 1 with its items. The form
// is inserted as a draft, filled, then published in the same transaction, the way
// the publish service works, because items cannot be added to a published form.
async function seedForm(tx: Tx, roleId: string, def: SeedForm, aiDisclosureVersionId: string, now: Date, bump: Bump) {
  const existing = await tx
    .select({ id: formVersion.id })
    .from(formVersion)
    .where(and(eq(formVersion.roleId, roleId), eq(formVersion.version, 1)));
  if (existing[0]) return;

  const sectionKeys = new Set(def.sections.map((section) => section.key));
  const formVersionId = uuidv7();
  await tx.insert(formVersion).values({
    id: formVersionId,
    roleId,
    version: 1,
    status: "draft",
    sections: def.sections,
    aiDisclosureVersionId,
    changeReason: def.changeReason,
    createdBy: null,
  });
  bump("form_version");

  let sortOrder = 0;
  for (const q of def.questions) {
    if (!sectionKeys.has(q.section)) throw new Error(`Question ${q.key} names unknown section ${q.section}`);

    let questionRow = (
      await tx
        .select({ id: question.id })
        .from(question)
        .where(and(eq(question.roleId, roleId), eq(question.key, q.key)))
    )[0];
    if (!questionRow) {
      questionRow = { id: uuidv7() };
      await tx.insert(question).values({ id: questionRow.id, roleId, key: q.key, aiNeverSend: q.aiNeverSend ?? false });
      bump("question");
    }

    let versionRow = (
      await tx
        .select({ id: questionVersion.id })
        .from(questionVersion)
        .where(and(eq(questionVersion.questionId, questionRow.id), eq(questionVersion.version, 1)))
    )[0];
    if (!versionRow) {
      versionRow = { id: uuidv7() };
      await tx.insert(questionVersion).values({
        id: versionRow.id,
        questionId: questionRow.id,
        version: 1,
        type: q.type,
        prompt: q.prompt,
        help: q.help ?? null,
        options: q.options ?? null,
        validation: q.validation ?? null,
        meaningChanged: false,
        changeNote: null,
        publishedAt: def.publish ? now : null,
        createdBy: null,
      });
      bump("question_version");
    }

    sortOrder += 10;
    await tx.insert(formItem).values({
      formVersionId,
      questionVersionId: versionRow.id,
      sectionKey: q.section,
      sortOrder,
      required: q.required,
      attentionValues: q.attention ?? null,
    });
    bump("form_item");
  }

  if (def.publish) {
    await tx
      .update(formVersion)
      .set({ status: "published", publishedAt: now, publishedBy: null })
      .where(eq(formVersion.id, formVersionId));
  }
}

async function seedOpenings(tx: Tx, roleIds: Record<RoleKey, string>, bump: Bump): Promise<string> {
  const { snow, window } = ownerInput;
  // The service rule for Settings > Openings, applied to the seed too.
  if (!snow.payText || !snow.opensOn) {
    throw new Error("The snow opening cannot be seeded open without pay text and an opens-on date");
  }

  const defs = [
    {
      roleId: roleIds.snow_removal_tech,
      key: "snow-2026-27",
      name: "Snow Removal 2026-27",
      status: "open" as const,
      opensOn: snow.opensOn,
      payText: snow.payText,
      benefitsText: snow.benefitsText,
      seasonStartOn: snow.seasonStartOn,
      seasonEndOn: snow.seasonEndOn,
      targetHeadcount: snow.targetHeadcount,
    },
    {
      roleId: roleIds.window_cleaning_tech,
      key: "window-2027",
      name: "Window Cleaning 2027",
      status: "draft" as const,
      opensOn: window.opensOn,
      payText: window.payText,
      benefitsText: window.benefitsText,
      seasonStartOn: window.seasonStartOn,
      seasonEndOn: window.seasonEndOn,
      targetHeadcount: window.targetHeadcount,
    },
  ];

  let snowOpeningId = "";
  for (const def of defs) {
    const existing = await tx
      .select({ id: opening.id })
      .from(opening)
      .where(and(eq(opening.roleId, def.roleId), eq(opening.key, def.key)));
    let id = existing[0]?.id;
    if (!id) {
      id = uuidv7();
      await tx.insert(opening).values({ id, ...def });
      bump("opening");
    }
    if (def.key === "snow-2026-27") snowOpeningId = id;
  }
  return snowOpeningId;
}

// The two launch codes, with fixed values so they exist before anything is printed.
async function seedEntryCodes(tx: Tx, snowRoleId: string, snowOpeningId: string, bump: Bump) {
  const codes = [
    {
      code: LAUNCH_ENTRY_CODES.snowRoleQr,
      channel: "role_qr" as const,
      label: "Snow role QR code (launch)",
      // Null opening: resolves to whichever snow opening is open at scan time.
      openingId: null,
    },
    {
      code: LAUNCH_ENTRY_CODES.snowIndeedMessage,
      channel: "indeed_message" as const,
      label: "Snow Indeed message link (launch)",
      openingId: snowOpeningId,
    },
  ];
  for (const def of codes) {
    const existing = await tx.select({ id: entryCode.id }).from(entryCode).where(eq(entryCode.code, def.code));
    if (existing[0]) continue;
    await tx.insert(entryCode).values({ id: uuidv7(), roleId: snowRoleId, groupSessionId: null, createdBy: null, ...def });
    bump("entry_code");
  }
}
