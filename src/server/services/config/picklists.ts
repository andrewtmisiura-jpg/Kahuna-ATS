import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application, applicationEvent, assessment, hireStint, picklistOption, reviewDecision, role, star } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { getEmployer } from "./employer";
import { ConfigError, PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors";

// Settings > Picklists (DATA_MODEL.md, picklist_option): add, relabel, archive and
// unarchive options in every small staff-facing list. This screen is how crews are
// entered. Editor rule: list_key, employer_id, role_id, key and fcra_adverse cannot
// change once any row references the option; archive it and add a new one instead.

export type PicklistOptionRow = typeof picklistOption.$inferSelect;
export type PicklistKey = PicklistOptionRow["listKey"];
export type SeparationType = NonNullable<PicklistOptionRow["defaultSeparation"]>;

export type PicklistOptionListRow = PicklistOptionRow & { roleName: string | null };

export const PICKLISTS: { key: PicklistKey; label: string; description: string }[] = [
  { key: "disqualify_reason", label: "Disqualify reasons", description: "Why an application was closed as Disqualified." },
  { key: "withdraw_reason", label: "Withdraw reasons", description: "Why an applicant pulled out." },
  { key: "not_selected_reason", label: "Not-selected reasons", description: "Why a fine applicant was not taken on." },
  { key: "crew", label: "Crews", description: "Crews a hire can be assigned to on the hire form." },
  { key: "leave_reason", label: "Leave reasons", description: "Why a hire left, with the usual separation type." },
  { key: "star_reason", label: "Star reasons", description: "Reasons for a star or a concern on a group interview's floor view." },
  { key: "assessment_type", label: "Assessment types", description: "Tests such as the ladder test, recorded on the profile." },
];

export const PICKLIST_KEYS = PICKLISTS.map((list) => list.key);

export function isPicklistKey(value: unknown): value is PicklistKey {
  return typeof value === "string" && (PICKLIST_KEYS as string[]).includes(value);
}

// The columns locked once anything references the option.
const LOCKED = ["listKey", "employerId", "roleId", "key", "fcraAdverse"] as const;
const AUDITED = [...LOCKED, "label", "requiresNote", "defaultSeparation", "sortOrder", "archivedAt"] as const;

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export async function listPicklistOptions(db: Db): Promise<PicklistOptionListRow[]> {
  const rows = await db
    .select({ option: picklistOption, roleName: role.internalName })
    .from(picklistOption)
    .leftJoin(role, eq(role.id, picklistOption.roleId))
    .orderBy(asc(picklistOption.listKey), asc(picklistOption.sortOrder), asc(picklistOption.label));
  return rows.map((r) => ({ ...r.option, roleName: r.roleName }));
}

export async function getPicklistOption(db: Db, id: string): Promise<PicklistOptionRow | null> {
  const [row] = await db.select().from(picklistOption).where(eq(picklistOption.id, id));
  return row ?? null;
}

// True when any application, event, hire, star, test result or review decision row
// points at the option, which is when its key, list, scope and FCRA flag become part
// of the historical record.
export async function isOptionReferenced(db: Db, optionId: string): Promise<boolean> {
  const [row] = await db
    .select({
      referenced: sql<boolean>`
        exists (select 1 from ${application} where ${application.closedReasonOptionId} = ${optionId})
        or exists (select 1 from ${applicationEvent} where ${applicationEvent.reasonOptionId} = ${optionId})
        or exists (select 1 from ${hireStint} where ${hireStint.crewOptionId} = ${optionId})
        or exists (select 1 from ${hireStint} where ${hireStint.leaveReasonOptionId} = ${optionId})
        or exists (select 1 from ${star} where ${star.reasonOptionId} = ${optionId})
        or exists (select 1 from ${assessment} where ${assessment.assessmentTypeOptionId} = ${optionId})
        or exists (select 1 from ${reviewDecision} where ${reviewDecision.reasonOptionId} = ${optionId})`,
    })
    .from(sql`(select 1) as one`);
  return Boolean(row?.referenced);
}

type OptionFields = {
  key: string;
  label: string;
  requiresNote: boolean;
  fcraAdverse: boolean;
  defaultSeparation: SeparationType | null;
};

function cleanLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) throw new ConfigError("invalid_input", "Enter a label");
  if (trimmed.length > 120) throw new ConfigError("invalid_input", "Keep the label under 120 characters");
  return trimmed;
}

function cleanKey(key: string): string {
  const trimmed = key.trim();
  if (!KEY_PATTERN.test(trimmed)) {
    throw new ConfigError("invalid_input", "Key must be lowercase letters, digits and underscores, starting with a letter");
  }
  return trimmed;
}

function checkListRules(listKey: PicklistKey, fields: Pick<OptionFields, "fcraAdverse" | "defaultSeparation">) {
  if (fields.fcraAdverse && listKey !== "disqualify_reason") {
    throw new ConfigError("fcra_only_disqualify", "Only disqualify reasons can be marked as background-based");
  }
  if (fields.defaultSeparation && listKey !== "leave_reason") {
    throw new ConfigError("separation_only_leave", "Only leave reasons carry a default separation type");
  }
}

export async function addPicklistOption(
  db: Db,
  input: {
    actor: Actor;
    listKey: PicklistKey;
    roleId?: string | null;
    key: string;
    label: string;
    requiresNote?: boolean;
    fcraAdverse?: boolean;
    defaultSeparation?: SeparationType | null;
  },
): Promise<PicklistOptionRow> {
  if (!isPicklistKey(input.listKey)) throw new ConfigError("invalid_input", "Unknown list");
  const fields: OptionFields = {
    key: cleanKey(input.key),
    label: cleanLabel(input.label),
    requiresNote: input.requiresNote ?? false,
    fcraAdverse: input.fcraAdverse ?? false,
    defaultSeparation: input.defaultSeparation ?? null,
  };
  checkListRules(input.listKey, fields);
  const roleId = input.roleId || null;

  return db.transaction(async (tx) => {
    const emp = await getEmployer(tx);
    if (roleId) {
      const [r] = await tx.select({ id: role.id }).from(role).where(eq(role.id, roleId));
      if (!r) throw new ConfigError("not_found", "No such role");
    }
    const [top] = await tx
      .select({ sortOrder: max(picklistOption.sortOrder) })
      .from(picklistOption)
      .where(
        and(
          eq(picklistOption.listKey, input.listKey),
          eq(picklistOption.employerId, emp.id),
          roleId ? eq(picklistOption.roleId, roleId) : isNull(picklistOption.roleId),
        ),
      );
    const id = uuidv7();
    let row: PicklistOptionRow;
    try {
      [row] = (await tx
        .insert(picklistOption)
        .values({ id, listKey: input.listKey, employerId: emp.id, roleId, sortOrder: (top?.sortOrder ?? 0) + 10, ...fields })
        .returning()) as [PicklistOptionRow];
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw new ConfigError("picklist_key_exists", `An option with key "${fields.key}" already exists in this list`);
      }
      throw error;
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "picklist_option.add",
      entityType: "picklist_option",
      entityId: id,
      changes: {
        listKey: { from: null, to: row.listKey },
        roleId: { from: null, to: row.roleId },
        key: { from: null, to: row.key },
        label: { from: null, to: row.label },
        requiresNote: { from: null, to: row.requiresNote },
        fcraAdverse: { from: null, to: row.fcraAdverse },
        defaultSeparation: { from: null, to: row.defaultSeparation },
      },
    });
    return row;
  });
}

export type PicklistOptionPatch = Partial<OptionFields> & { listKey?: PicklistKey; roleId?: string | null; sortOrder?: number };

// Labels, the note flag and the default separation are always editable. The locked
// columns may change only while nothing references the option.
export async function updatePicklistOption(
  db: Db,
  input: { actor: Actor; id: string; patch: PicklistOptionPatch },
): Promise<PicklistOptionRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(picklistOption).where(eq(picklistOption.id, input.id)).for("update");
    if (!before) throw new ConfigError("not_found", "No such option");

    const p = input.patch;
    const next = {
      listKey: p.listKey ?? before.listKey,
      roleId: p.roleId === undefined ? before.roleId : p.roleId || null,
      key: p.key === undefined ? before.key : cleanKey(p.key),
      label: p.label === undefined ? before.label : cleanLabel(p.label),
      requiresNote: p.requiresNote ?? before.requiresNote,
      fcraAdverse: p.fcraAdverse ?? before.fcraAdverse,
      defaultSeparation: p.defaultSeparation === undefined ? before.defaultSeparation : p.defaultSeparation,
      sortOrder: p.sortOrder ?? before.sortOrder,
    };
    if (!isPicklistKey(next.listKey)) throw new ConfigError("invalid_input", "Unknown list");
    if (p.sortOrder !== undefined && !Number.isInteger(p.sortOrder)) {
      throw new ConfigError("invalid_input", "Sort order must be a whole number");
    }
    checkListRules(next.listKey, next);

    // employerId never changes here; the other locked columns are compared.
    const lockedChanged = (["listKey", "roleId", "key", "fcraAdverse"] as const).filter((field) => before[field] !== next[field]);
    if (lockedChanged.length > 0 && (await isOptionReferenced(tx, before.id))) {
      throw new ConfigError(
        "picklist_locked",
        "This option is already in use, so its key, list, scope and background flag cannot change. Archive it and add a new one.",
      );
    }

    let after: PicklistOptionRow;
    try {
      [after] = (await tx.update(picklistOption).set(next).where(eq(picklistOption.id, before.id)).returning()) as [PicklistOptionRow];
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw new ConfigError("picklist_key_exists", `An option with key "${next.key}" already exists in this list`);
      }
      throw error;
    }
    const changes = diffChanges(before, after, AUDITED);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "picklist_option.update",
        entityType: "picklist_option",
        entityId: before.id,
        changes,
      });
    }
    return after;
  });
}

async function setArchived(db: Db, actor: Actor, id: string, archived: boolean): Promise<PicklistOptionRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(picklistOption).where(eq(picklistOption.id, id)).for("update");
    if (!before) throw new ConfigError("not_found", "No such option");
    if (Boolean(before.archivedAt) === archived) return before;
    const [after] = await tx
      .update(picklistOption)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(picklistOption.id, id))
      .returning();
    await writeAudit(tx, {
      actor,
      action: archived ? "picklist_option.archive" : "picklist_option.unarchive",
      entityType: "picklist_option",
      entityId: id,
      changes: diffChanges(before, after!, ["archivedAt"]),
    });
    return after!;
  });
}

export function archivePicklistOption(db: Db, input: { actor: Actor; id: string }) {
  return setArchived(db, input.actor, input.id, true);
}

export function unarchivePicklistOption(db: Db, input: { actor: Actor; id: string }) {
  return setArchived(db, input.actor, input.id, false);
}
