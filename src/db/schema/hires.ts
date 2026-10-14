import { sql } from "drizzle-orm";
import { boolean, check, date, index, numeric, pgTable, smallint, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { employer, opening, picklistOption, role } from "./config";
import {
  backgroundCheckStatusEnum,
  backgroundCheckTypeEnum,
  hireOriginEnum,
  hireOutcomeEnum,
  hireVoidKindEnum,
  offerResponseEnum,
  payUnitEnum,
  seasonEndRatingEnum,
  separationTypeEnum,
} from "./enums";
import { application, person } from "./people";

// Offers, background checks and hire stints (DATA_MODEL.md, "Offers, checks and hires").

// Created by the move into an offered stage, edited on the profile panel.
export const offer = pgTable(
  "offer",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    // The Central date of the stage move's occurred_at. Read-only afterward.
    offeredOn: date({ mode: "string" }).notNull(),
    offeredBy: uuid()
      .notNull()
      .references(() => appUser.id),
    isConditional: boolean().notNull().default(true),
    payAmount: numeric({ precision: 8, scale: 2 }),
    payUnit: payUnitEnum(),
    plannedStartOn: date({ mode: "string" }),
    response: offerResponseEnum().notNull().default("pending"),
    respondedOn: date({ mode: "string" }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
  },
  (table) => [index("offer_application_id_offered_on_idx").on(table.applicationId, table.offeredOn)],
);

// Status and dates only. Never report contents, SSN or date of birth.
export const backgroundCheck = pgTable(
  "background_check",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    // No check without an offer; the service checks the offer is live and on the same application.
    offerId: uuid()
      .notNull()
      .references(() => offer.id),
    checkType: backgroundCheckTypeEnum().notNull(),
    vendor: text(),
    vendorReference: text(),
    status: backgroundCheckStatusEnum().notNull(),
    requestedOn: date({ mode: "string" }),
    completedOn: date({ mode: "string" }),
    // Write-once except for Admins; any change is audited.
    preAdverseNoticeOn: date({ mode: "string" }),
    finalAdverseOn: date({ mode: "string" }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("background_check_application_id_idx").on(table.applicationId),
    check(
      "background_check_final_adverse_needs_pre_adverse",
      sql`${table.finalAdverseOn} is null or ${table.preAdverseNoticeOn} is not null`,
    ),
  ],
);

// One row per person per role per season.
export const hireStint = pgTable(
  "hire_stint",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    applicationId: uuid().references(() => application.id),
    origin: hireOriginEnum().notNull(),
    employerId: uuid()
      .notNull()
      .references(() => employer.id),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    // Required for ATS stints; the service checks it matches the application's.
    openingId: uuid().references(() => opening.id),
    // "Temporary hire: planned short engagement". Left out of retention numbers.
    isTemporary: boolean().notNull().default(false),
    plannedEndOn: date({ mode: "string" }),
    crewOptionId: uuid().references(() => picklistOption.id),
    offerAcceptedOn: date({ mode: "string" }),
    plannedStartOn: date({ mode: "string" }),
    // First day actually worked. Null for an on-call tech who hasn't worked yet.
    startOn: date({ mode: "string" }),
    lastWorkedOn: date({ mode: "string" }),
    // The separation date, or the season end for completed_season.
    endOn: date({ mode: "string" }),
    outcome: hireOutcomeEnum().notNull().default("active"),
    separationType: separationTypeEnum(),
    leaveReasonOptionId: uuid().references(() => picklistOption.id),
    leaveNote: text(),
    rehireEligible: boolean(),
    rating30: smallint("rating_30"),
    rating90: smallint("rating_90"),
    rating30By: uuid("rating_30_by").references(() => appUser.id),
    rating90By: uuid("rating_90_by").references(() => appUser.id),
    seasonEndRating: seasonEndRatingEnum(),
    stormsWorked: smallint(),
    voidedAt: timestamptz(),
    voidKind: hireVoidKindEnum(),
    voidReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hire_stint_one_active_per_application")
      .on(table.applicationId)
      .where(sql`voided_at is null and outcome = 'active'`),
    uniqueIndex("hire_stint_one_active_per_person_per_opening")
      .on(table.personId, table.openingId)
      .where(sql`voided_at is null and outcome = 'active' and opening_id is not null`),
    index("hire_stint_role_id_start_on_idx").on(table.roleId, table.startOn),
    index("hire_stint_person_id_idx").on(table.personId),
    index("hire_stint_opening_id_idx").on(table.openingId),
    check(
      "hire_stint_separation_fields",
      sql`${table.outcome} not in ('separated', 'never_started') or (${table.separationType} is not null and ${table.leaveReasonOptionId} is not null and ${table.endOn} is not null)`,
    ),
    check("hire_stint_completed_has_end", sql`${table.outcome} <> 'completed_season' or ${table.endOn} is not null`),
    check(
      "hire_stint_end_after_start",
      sql`${table.startOn} is null or ${table.endOn} is null or ${table.endOn} >= ${table.startOn}`,
    ),
    check(
      "hire_stint_last_worked_in_range",
      sql`${table.lastWorkedOn} is null or ((${table.startOn} is null or ${table.lastWorkedOn} >= ${table.startOn}) and (${table.endOn} is null or ${table.lastWorkedOn} <= ${table.endOn}))`,
    ),
    check("hire_stint_rating_30_range", sql`${table.rating30} is null or ${table.rating30} between 1 and 5`),
    check("hire_stint_rating_90_range", sql`${table.rating90} is null or ${table.rating90} between 1 and 5`),
    check(
      "hire_stint_ats_has_application",
      sql`${table.origin} <> 'ats' or (${table.applicationId} is not null and ${table.openingId} is not null)`,
    ),
    check("hire_stint_void_fields_together", sql`(${table.voidedAt} is null) = (${table.voidKind} is null)`),
  ],
);
