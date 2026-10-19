import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { employer, opening, pipelineStage, role } from "@/db/schema";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { ConfigError, PG_UNIQUE_VIOLATION, pgErrorCode } from "./errors";

// Settings > Openings (DATA_MODEL.md, opening): status, dates, season dates, pay,
// benefits and headcount per season. The service refuses to open an opening
// without pay text and an opens-on date and keeps one open opening per role; the
// partial unique index backs the second rule. Every change is audited.

export type OpeningRow = typeof opening.$inferSelect;
export type OpeningStatus = OpeningRow["status"];

export type OpeningListRow = OpeningRow & { roleName: string; roleKey: string; roleSortOrder: number };

export type OpeningPatch = {
  status: OpeningStatus;
  opensOn: string | null;
  closesOn: string | null;
  seasonStartOn: string | null;
  seasonEndOn: string | null;
  targetHeadcount: number | null;
  payText: string | null;
  benefitsText: string | null;
};

const EDITABLE = [
  "status",
  "opensOn",
  "closesOn",
  "seasonStartOn",
  "seasonEndOn",
  "targetHeadcount",
  "payText",
  "benefitsText",
] as const satisfies readonly (keyof OpeningPatch)[];

export async function listOpenings(db: Db): Promise<OpeningListRow[]> {
  const rows = await db
    .select({ opening, roleName: role.internalName, roleKey: role.key, roleSortOrder: role.sortOrder })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .orderBy(asc(role.sortOrder), desc(opening.opensOn), desc(opening.createdAt));
  return rows.map((r) => ({ ...r.opening, roleName: r.roleName, roleKey: r.roleKey, roleSortOrder: r.roleSortOrder }));
}

export type RoleWaitingOnBookingLink = { roleId: string; roleName: string };

// Roles that invite people to a one-on-one (a live stage at the interview_invited
// milestone) and have a draft or open opening, while no booking link is set: their
// invites cannot go out yet. Settings > Openings shows these as a reminder, since the
// window opening is months off when the link is first needed (owner, Oct 19, 2026).
export async function rolesWaitingOnBookingLink(db: Db): Promise<RoleWaitingOnBookingLink[]> {
  const [emp] = await db
    .select({ id: employer.id, bookingLinkUrl: employer.bookingLinkUrl })
    .from(employer)
    .where(isNull(employer.archivedAt))
    .orderBy(asc(employer.createdAt))
    .limit(1);
  if (!emp || emp.bookingLinkUrl) return [];
  return db
    .selectDistinct({ roleId: role.id, roleName: role.internalName, sortOrder: role.sortOrder })
    .from(role)
    .innerJoin(
      pipelineStage,
      and(eq(pipelineStage.roleId, role.id), isNull(pipelineStage.archivedAt), eq(pipelineStage.milestone, "interview_invited")),
    )
    .innerJoin(opening, and(eq(opening.roleId, role.id), ne(opening.status, "closed")))
    .where(and(eq(role.employerId, emp.id), isNull(role.archivedAt)))
    .orderBy(asc(role.sortOrder))
    .then((rows) => rows.map(({ roleId, roleName }) => ({ roleId, roleName })));
}

export async function getOpening(db: Db, id: string): Promise<OpeningRow | null> {
  const [row] = await db.select().from(opening).where(eq(opening.id, id));
  return row ?? null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  if (!DATE.test(value)) throw new ConfigError("invalid_input", `${field} must be a date (YYYY-MM-DD)`);
  return value;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// Normalizes a patch and applies the opening rules against the row it will replace.
export function validateOpeningPatch(patch: OpeningPatch): OpeningPatch {
  const next: OpeningPatch = {
    status: patch.status,
    opensOn: cleanDate(patch.opensOn, "Opens on"),
    closesOn: cleanDate(patch.closesOn, "Closes on"),
    seasonStartOn: cleanDate(patch.seasonStartOn, "Season start"),
    seasonEndOn: cleanDate(patch.seasonEndOn, "Season end"),
    targetHeadcount: patch.targetHeadcount,
    payText: cleanText(patch.payText),
    benefitsText: cleanText(patch.benefitsText),
  };
  if (!["draft", "open", "closed"].includes(next.status)) {
    throw new ConfigError("invalid_input", "Status must be draft, open or closed");
  }
  if (next.targetHeadcount !== null && (!Number.isInteger(next.targetHeadcount) || next.targetHeadcount < 0)) {
    throw new ConfigError("invalid_input", "Target headcount must be a whole number");
  }
  if (next.opensOn && next.closesOn && next.closesOn < next.opensOn) {
    throw new ConfigError("dates_out_of_order", "Closes on must be on or after opens on");
  }
  if (next.seasonStartOn && next.seasonEndOn && next.seasonEndOn < next.seasonStartOn) {
    throw new ConfigError("dates_out_of_order", "Season end must be on or after season start");
  }
  if (next.status === "open") {
    if (!next.payText) throw new ConfigError("opening_missing_pay_text", "Add the pay text before opening this opening");
    if (!next.opensOn) throw new ConfigError("opening_missing_opens_on", "Set the opens-on date before opening this opening");
  }
  return next;
}

export async function updateOpening(
  db: Db,
  input: { actor: Actor; id: string; patch: OpeningPatch },
): Promise<OpeningRow> {
  const next = validateOpeningPatch(input.patch);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(opening).where(eq(opening.id, input.id)).for("update");
    if (!existing) throw new ConfigError("not_found", "No such opening");

    if (next.status === "open" && existing.status !== "open") {
      const [other] = await tx
        .select({ id: opening.id, name: opening.name })
        .from(opening)
        .where(and(eq(opening.roleId, existing.roleId), eq(opening.status, "open"), ne(opening.id, existing.id)));
      if (other) {
        throw new ConfigError("role_already_open", `${other.name} is already open for this role. Close it first.`);
      }
    }

    let updated: OpeningRow;
    try {
      [updated] = (await tx.update(opening).set(next).where(eq(opening.id, existing.id)).returning()) as [OpeningRow];
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw new ConfigError("role_already_open", "Another opening of this role is already open. Close it first.");
      }
      throw error;
    }

    const changes = diffChanges(existing, updated, EDITABLE);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "opening.update",
        entityType: "opening",
        entityId: existing.id,
        changes,
      });
    }
    return updated;
  });
}
