import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { backgroundCheck, hireStint, offer, picklistOption, role } from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "../actor";
import { diffChanges, writeAudit } from "../audit";
import { isOpenCheck } from "./transition";

// The rows a stage move creates and the profile panels edit afterwards
// (DATA_MODEL.md, offer, background_check and hire_stint). Every edit is audited.

export type RecordErrorCode =
  | "offer_not_found"
  | "check_not_found"
  | "stint_not_found"
  | "pre_adverse_locked"
  | "pre_adverse_required"
  | "fcra_statement_required"
  | "separation_fields_required"
  | "end_date_required"
  | "rehire_eligible_required"
  | "season_end_rating_required"
  | "temporary_locked"
  | "reason_required"
  | "invalid_rating"
  | "option_not_found"
  | "invalid_dates";

export class RecordError extends Error {
  constructor(
    readonly code: RecordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordError";
  }
}

type OfferRow = typeof offer.$inferSelect;
type CheckRow = typeof backgroundCheck.$inferSelect;
type StintRow = typeof hireStint.$inferSelect;

// ---------------------------------------------------------------------------
// Offer

export type OfferPatch = {
  isConditional?: boolean;
  payAmount?: string | null;
  payUnit?: OfferRow["payUnit"];
  plannedStartOn?: string | null;
  response?: OfferRow["response"];
  respondedOn?: string | null;
  note?: string | null;
  // Required when the response becomes rescinded while a check is open (the FCRA guard).
  notReportBased?: boolean;
};

const OFFER_FIELDS = ["isConditional", "payAmount", "payUnit", "plannedStartOn", "response", "respondedOn", "note"] as const;

export async function updateOffer(db: Db, input: { offerId: string; userId: string; patch: OfferPatch; now?: Date }): Promise<OfferRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(offer).where(eq(offer.id, input.offerId)).for("update");
    if (!before || before.deletedAt) throw new RecordError("offer_not_found", "No such offer");
    const p = input.patch;
    const after: OfferRow = {
      ...before,
      isConditional: p.isConditional ?? before.isConditional,
      payAmount: p.payAmount === undefined ? before.payAmount : p.payAmount,
      payUnit: p.payUnit === undefined ? before.payUnit : p.payUnit,
      plannedStartOn: p.plannedStartOn === undefined ? before.plannedStartOn : p.plannedStartOn,
      response: p.response ?? before.response,
      respondedOn: p.respondedOn === undefined ? before.respondedOn : p.respondedOn,
      note: p.note === undefined ? before.note : p.note,
    };
    const changes = diffChanges(before, after, OFFER_FIELDS, ["note"]);
    if (Object.keys(changes).length === 0) return before;

    // Rescinding while a check is open is a decision the FCRA steps apply to.
    if (after.response === "rescinded" && before.response !== "rescinded") {
      const checks = await tx.select().from(backgroundCheck).where(eq(backgroundCheck.applicationId, before.applicationId));
      const open = checks.filter(isOpenCheck);
      if (open.length > 0 && !p.notReportBased) {
        throw new RecordError(
          "fcra_statement_required",
          "A background check is open: confirm this decision does not rely on the report, or close the application with a background-based reason",
        );
      }
      if (open.length > 0) changes.not_report_based = { open_background_check_ids: open.map((c) => c.id) };
    }

    const [updated] = await tx
      .update(offer)
      .set({
        isConditional: after.isConditional,
        payAmount: after.payAmount,
        payUnit: after.payUnit,
        plannedStartOn: after.plannedStartOn,
        response: after.response,
        respondedOn: after.respondedOn ?? (after.response !== "pending" && before.response === "pending" ? null : after.respondedOn),
        note: after.note,
        updatedAt: now,
      })
      .where(eq(offer.id, before.id))
      .returning();
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "offer.update",
      entityType: "offer",
      entityId: before.id,
      applicationId: before.applicationId,
      changes,
      occurredAt: now,
    });
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Background check

export type CheckPatch = {
  status?: CheckRow["status"];
  vendor?: string | null;
  vendorReference?: string | null;
  requestedOn?: string | null;
  completedOn?: string | null;
  preAdverseNoticeOn?: string | null;
  finalAdverseOn?: string | null;
  note?: string | null;
};

const CHECK_FIELDS = ["status", "vendor", "vendorReference", "requestedOn", "completedOn", "preAdverseNoticeOn", "finalAdverseOn", "note"] as const;

export async function updateBackgroundCheck(
  db: Db,
  input: { checkId: string; userId: string; role: UserRole; patch: CheckPatch; now?: Date },
): Promise<CheckRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(backgroundCheck).where(eq(backgroundCheck.id, input.checkId)).for("update");
    if (!before) throw new RecordError("check_not_found", "No such background check");
    const p = input.patch;
    const pick = <K extends keyof CheckPatch & keyof CheckRow>(key: K): CheckRow[K] =>
      (p[key] === undefined ? before[key] : p[key]) as CheckRow[K];
    const after: CheckRow = {
      ...before,
      status: pick("status"),
      vendor: pick("vendor"),
      vendorReference: pick("vendorReference"),
      requestedOn: pick("requestedOn"),
      completedOn: pick("completedOn"),
      preAdverseNoticeOn: pick("preAdverseNoticeOn"),
      finalAdverseOn: pick("finalAdverseOn"),
      note: pick("note"),
    };
    // The pre-adverse notice date starts the FCRA clock: write-once except for Admins.
    if (before.preAdverseNoticeOn && after.preAdverseNoticeOn !== before.preAdverseNoticeOn && input.role !== "admin") {
      throw new RecordError("pre_adverse_locked", "The pre-adverse notice date is set. Only an Admin can change it.");
    }
    if (after.finalAdverseOn && !after.preAdverseNoticeOn) {
      throw new RecordError("pre_adverse_required", "Record the pre-adverse notice date before the final adverse date");
    }
    if (after.status === "pre_adverse_sent" && !after.preAdverseNoticeOn) {
      throw new RecordError("pre_adverse_required", "Enter the date the pre-adverse notice went out");
    }
    const changes = diffChanges(before, after, CHECK_FIELDS, ["vendorReference", "note"]);
    if (Object.keys(changes).length === 0) return before;
    const [updated] = await tx
      .update(backgroundCheck)
      .set({
        status: after.status,
        vendor: after.vendor,
        vendorReference: after.vendorReference,
        requestedOn: after.requestedOn,
        completedOn: after.completedOn,
        preAdverseNoticeOn: after.preAdverseNoticeOn,
        finalAdverseOn: after.finalAdverseOn,
        note: after.note,
        updatedAt: now,
      })
      .where(eq(backgroundCheck.id, before.id))
      .returning();
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "background_check.update",
      entityType: "background_check",
      entityId: before.id,
      applicationId: before.applicationId,
      changes,
      occurredAt: now,
    });
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Hire stint (the hire form)

export type StintPatch = {
  isTemporary?: boolean;
  plannedEndOn?: string | null;
  crewOptionId?: string | null;
  plannedStartOn?: string | null;
  startOn?: string | null;
  lastWorkedOn?: string | null;
  endOn?: string | null;
  outcome?: StintRow["outcome"];
  separationType?: StintRow["separationType"];
  leaveReasonOptionId?: string | null;
  leaveNote?: string | null;
  rehireEligible?: boolean | null;
  rating30?: number | null;
  rating90?: number | null;
  seasonEndRating?: StintRow["seasonEndRating"];
  stormsWorked?: number | null;
  // An Admin's written reason for flipping the temporary flag after an exit.
  temporaryChangeReason?: string | null;
};

const STINT_FIELDS = [
  "isTemporary",
  "plannedEndOn",
  "crewOptionId",
  "plannedStartOn",
  "startOn",
  "lastWorkedOn",
  "endOn",
  "outcome",
  "separationType",
  "leaveReasonOptionId",
  "leaveNote",
  "rehireEligible",
  "rating30",
  "rating90",
  "seasonEndRating",
  "stormsWorked",
] as const;

function validRating(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= 5);
}

export async function updateHireStint(
  db: Db,
  input: { stintId: string; userId: string; role: UserRole; patch: StintPatch; now?: Date },
): Promise<StintRow> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(hireStint).where(eq(hireStint.id, input.stintId)).for("update");
    if (!before || before.voidedAt) throw new RecordError("stint_not_found", "No such hire record");
    const p = input.patch;
    const pick = <K extends keyof StintPatch & keyof StintRow>(key: K): StintRow[K] =>
      (p[key] === undefined ? before[key] : p[key]) as StintRow[K];
    const after: StintRow = {
      ...before,
      isTemporary: pick("isTemporary"),
      plannedEndOn: pick("plannedEndOn"),
      crewOptionId: pick("crewOptionId"),
      plannedStartOn: pick("plannedStartOn"),
      startOn: pick("startOn"),
      lastWorkedOn: pick("lastWorkedOn"),
      endOn: pick("endOn"),
      outcome: pick("outcome"),
      separationType: pick("separationType"),
      leaveReasonOptionId: pick("leaveReasonOptionId"),
      leaveNote: pick("leaveNote"),
      rehireEligible: pick("rehireEligible"),
      rating30: pick("rating30"),
      rating90: pick("rating90"),
      seasonEndRating: pick("seasonEndRating"),
      stormsWorked: pick("stormsWorked"),
    };
    if (!after.isTemporary) after.plannedEndOn = null;

    // The temporary flag is editable while active; after an exit only an Admin
    // with a written reason, because flipping it is the obvious way to erase a loss.
    if (after.isTemporary !== before.isTemporary && before.outcome !== "active") {
      if (input.role !== "admin") throw new RecordError("temporary_locked", "After an exit only an Admin can change the temporary flag");
      if (!p.temporaryChangeReason?.trim()) throw new RecordError("reason_required", "Give a reason for changing the temporary flag");
    }
    if (!validRating(after.rating30) || !validRating(after.rating90)) throw new RecordError("invalid_rating", "Ratings run from 1 to 5");
    if (after.stormsWorked !== null && (!Number.isInteger(after.stormsWorked) || after.stormsWorked < 0)) {
      throw new RecordError("invalid_rating", "Storms worked must be a whole number");
    }
    if (after.outcome === "separated" || after.outcome === "never_started") {
      if (!after.separationType || !after.leaveReasonOptionId || !after.endOn) {
        throw new RecordError("separation_fields_required", "A separation needs voluntary or involuntary, a leave reason and an end date");
      }
    }
    if (after.outcome === "completed_season" && !after.endOn) throw new RecordError("end_date_required", "Enter the end date");
    if ((after.outcome === "completed_season" || after.outcome === "separated") && after.rehireEligible === null) {
      throw new RecordError("rehire_eligible_required", "Say whether this person is eligible for rehire");
    }
    if (after.startOn && after.endOn && after.endOn < after.startOn) throw new RecordError("invalid_dates", "The end date is before the start date");
    if (after.lastWorkedOn && ((after.startOn && after.lastWorkedOn < after.startOn) || (after.endOn && after.lastWorkedOn > after.endOn))) {
      throw new RecordError("invalid_dates", "The last day worked must fall between the start and end dates");
    }
    if (after.outcome === "completed_season" && !after.seasonEndRating) {
      const [stintRole] = await tx.select({ key: role.key }).from(role).where(eq(role.id, before.roleId));
      if (stintRole?.key === "snow_removal_tech") throw new RecordError("season_end_rating_required", "Snow stints need a season-end rating");
    }
    if (after.leaveReasonOptionId && after.leaveReasonOptionId !== before.leaveReasonOptionId) {
      await assertOption(tx, after.leaveReasonOptionId, "leave_reason");
    }
    if (after.crewOptionId && after.crewOptionId !== before.crewOptionId) await assertOption(tx, after.crewOptionId, "crew");
    if (after.leaveReasonOptionId) {
      const [reason] = await tx.select().from(picklistOption).where(eq(picklistOption.id, after.leaveReasonOptionId));
      if (reason?.requiresNote && !after.leaveNote?.trim()) throw new RecordError("reason_required", "This leave reason needs a note");
    }

    const changes = diffChanges(before, after, STINT_FIELDS, ["leaveNote"]);
    if (Object.keys(changes).length === 0) return before;
    if (p.temporaryChangeReason?.trim() && changes.isTemporary) changes.temporary_change_reason = p.temporaryChangeReason.trim();

    const [updated] = await tx
      .update(hireStint)
      .set({
        isTemporary: after.isTemporary,
        plannedEndOn: after.plannedEndOn,
        crewOptionId: after.crewOptionId,
        plannedStartOn: after.plannedStartOn,
        startOn: after.startOn,
        lastWorkedOn: after.lastWorkedOn,
        endOn: after.endOn,
        outcome: after.outcome,
        separationType: after.separationType,
        leaveReasonOptionId: after.leaveReasonOptionId,
        leaveNote: after.leaveNote,
        rehireEligible: after.rehireEligible,
        rating30: after.rating30,
        rating90: after.rating90,
        rating30By: changes.rating30 ? (after.rating30 === null ? null : input.userId) : before.rating30By,
        rating90By: changes.rating90 ? (after.rating90 === null ? null : input.userId) : before.rating90By,
        seasonEndRating: after.seasonEndRating,
        stormsWorked: after.stormsWorked,
        updatedAt: now,
      })
      .where(eq(hireStint.id, before.id))
      .returning();
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "hire_stint.update",
      entityType: "hire_stint",
      entityId: before.id,
      personId: before.personId,
      applicationId: before.applicationId,
      changes,
      occurredAt: now,
    });
    return updated!;
  });
}

async function assertOption(db: Db, optionId: string, listKey: (typeof picklistOption.$inferSelect)["listKey"]) {
  const [row] = await db
    .select({ id: picklistOption.id })
    .from(picklistOption)
    .where(and(eq(picklistOption.id, optionId), eq(picklistOption.listKey, listKey)));
  if (!row) throw new RecordError("option_not_found", `That ${listKey.replace("_", " ")} option does not exist`);
}
