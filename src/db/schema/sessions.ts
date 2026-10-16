import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, id, phoneUsCheck, timestamptz, updatedAt } from "./columns";
import { picklistOption } from "./config";
import { groupSession } from "./entry";
import { attendeeSourceEnum, attributionMethodEnum, starMarkEnum } from "./enums";
import { application, person } from "./people";

// Who came to a group interview, and the stars and concerns staff gave them
// (DATA_MODEL.md, "Phase 2 tables": attendee and star).

// A name from a group interview sign-in sheet or the door check-in. Matching links an
// attendee to an application automatically only on an exact mobile match; a name match
// is a suggestion a person confirms.
export const attendee = pgTable(
  "attendee",
  {
    id: id(),
    groupSessionId: uuid()
      .notNull()
      .references(() => groupSession.id),
    // Null only after redaction (check).
    nameAsWritten: text(),
    mobileE164: text("mobile_e164"),
    source: attendeeSourceEnum().notNull(),
    // Set when matched.
    personId: uuid().references(() => person.id),
    applicationId: uuid().references(() => application.id),
    matchMethod: attributionMethodEnum().notNull().default("none"),
    matchedBy: uuid().references(() => appUser.id),
    matchedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
    // Stamped by the Phase 3 purge; present now because the name check reads it.
    redactedAt: timestamptz(),
  },
  (table) => [
    index("attendee_group_session_id_idx").on(table.groupSessionId),
    index("attendee_mobile_e164_idx").on(table.mobileE164),
    // One attendee row per application per session.
    uniqueIndex("attendee_one_per_application_per_session")
      .on(table.groupSessionId, table.applicationId)
      .where(sql`application_id is not null`),
    phoneUsCheck("attendee_mobile_e164_phone_us", table.mobileE164),
    check("attendee_name_required_unless_redacted", sql`${table.redactedAt} is not null or ${table.nameAsWritten} is not null`),
  ],
);

// A star or a concern one staff member gives an attendee, with an optional reason
// from the star_reason picklist and a short note.
export const star = pgTable(
  "star",
  {
    id: id(),
    attendeeId: uuid()
      .notNull()
      .references(() => attendee.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    mark: starMarkEnum().notNull(),
    reasonOptionId: uuid().references(() => picklistOption.id),
    // At most 140 characters (check).
    note: text(),
    createdAt: createdAt(),
    deletedAt: timestamptz(),
  },
  (table) => [
    // One live star and one live concern per staff member per attendee.
    uniqueIndex("star_one_live_per_user_and_mark")
      .on(table.attendeeId, table.userId, table.mark)
      .where(sql`deleted_at is null`),
    check("star_note_max_140", sql`${table.note} is null or char_length(${table.note}) <= 140`),
  ],
);
