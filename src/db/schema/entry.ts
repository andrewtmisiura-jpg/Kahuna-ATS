import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { createdAt, ENTRY_CODE_PATTERN, id, timestamptz, updatedAt } from "./columns";
import { opening, role } from "./config";
import { entryChannelEnum, groupSessionStatusEnum } from "./enums";

// Entry codes and group sessions (DATA_MODEL.md, "Entry codes and sessions").

// A group interview session. In Phase 1 because entry codes and applications reference it.
export const groupSession = pgTable(
  "group_session",
  {
    id: id(),
    openingId: uuid()
      .notNull()
      .references(() => opening.id),
    startsAt: timestamptz().notNull(),
    locationName: text().notNull(),
    locationAddress: text(),
    // Entered from Indeed.
    invitedCount: integer(),
    // Headcount from the sheet; once the session has attendee rows, screens count those instead.
    attendedCount: integer(),
    status: groupSessionStatusEnum().notNull(),
    notes: text(),
    createdBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz(),
  },
  (table) => [index("group_session_opening_id_starts_at_idx").on(table.openingId, table.startsAt)],
);

// Every printed or shared link. The QR encodes https://<hiring_host>/q/<code>.
export const entryCode = pgTable(
  "entry_code",
  {
    id: id(),
    // 6 to 8 characters, Crockford base32, uppercase.
    code: text().notNull().unique(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    // Null = whichever opening of the role is open at scan time.
    openingId: uuid().references(() => opening.id),
    groupSessionId: uuid().references(() => groupSession.id),
    channel: entryChannelEnum().notNull(),
    label: text().notNull(),
    // Closed codes fall back to the role page.
    closedAt: timestamptz(),
    createdBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("entry_code_group_session_id_idx").on(table.groupSessionId),
    check("entry_code_session_requires_opening", sql`${table.groupSessionId} is null or ${table.openingId} is not null`),
    check("entry_code_code_format", sql`${table.code} ~ ${sql.raw(`'${ENTRY_CODE_PATTERN}'`)}`),
  ],
);

// Anonymous daily scan counter. No IP, device or cookie is stored.
export const entryCodeScanDay = pgTable(
  "entry_code_scan_day",
  {
    entryCodeId: uuid()
      .notNull()
      .references(() => entryCode.id),
    // Central date.
    day: date({ mode: "string" }).notNull(),
    scans: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.entryCodeId, table.day] })],
);
