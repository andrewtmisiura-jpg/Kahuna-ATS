import { sql } from "drizzle-orm";
import { boolean, check, index, inet, pgTable, smallint, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { bytea, createdAt, id, timestamptz, updatedAt } from "./columns";
import { employer, legalTextVersion, messageTemplate } from "./config";
import { entryCode } from "./entry";
import {
  actorTypeEnum,
  channelEnum,
  consentActionEnum,
  consentMethodEnum,
  messageDirectionEnum,
  messageProviderEnum,
  messagePurposeEnum,
  messageStatusEnum,
  suppressionReasonEnum,
  tokenIssueEnum,
} from "./enums";
import { application, person } from "./people";

// Consent, suppression, the message log and resume tokens
// (DATA_MODEL.md, "Consent and messaging" and resume_token).

// Every text and email, in and out. Doubles as the outbound queue the cron works through.
export const message = pgTable(
  "message",
  {
    id: id(),
    direction: messageDirectionEnum().notNull(),
    channel: channelEnum().notNull(),
    // Null for unmatched inbound.
    personId: uuid().references(() => person.id),
    applicationId: uuid().references(() => application.id),
    // Null for inbound and for hand-typed staff replies.
    templateId: uuid().references(() => messageTemplate.id),
    purpose: messagePurposeEnum(),
    toAddress: text(),
    fromAddress: text(),
    subject: text(),
    // As sent or received; application links are stored as {link:<resume_token_id>}.
    body: text(),
    status: messageStatusEnum().notNull(),
    provider: messageProviderEnum().notNull(),
    providerMessageId: text(),
    errorCode: text(),
    segments: smallint(),
    // e.g. reminder_24h:<application_id>; one send at most.
    dedupeKey: text(),
    // Also holds texts waiting for 9am.
    sendAfter: timestamptz(),
    attempts: smallint().notNull().default(0),
    lockedAt: timestamptz(),
    sentAt: timestamptz(),
    deliveredAt: timestamptz(),
    failedAt: timestamptz(),
    triggeredByType: actorTypeEnum().notNull(),
    triggeredByUserId: uuid().references(() => appUser.id),
    // Inbound triage: every inbound text stays "unhandled" until a person marks it.
    handledAt: timestamptz(),
    handledBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Stamped by the Phase 3 purge; present now because the address check reads it.
    redactedAt: timestamptz(),
  },
  (table) => [
    unique("message_provider_message_id_unique").on(table.providerMessageId),
    unique("message_dedupe_key_unique").on(table.dedupeKey),
    index("message_send_after_queued_idx").on(table.sendAfter).where(sql`status = 'queued'`),
    index("message_application_id_created_at_idx").on(table.applicationId, table.createdAt),
    index("message_person_id_created_at_idx").on(table.personId, table.createdAt),
    index("message_inbound_unhandled_idx")
      .on(table.createdAt)
      .where(sql`direction = 'inbound' and handled_at is null`),
    check(
      "message_addresses_unless_redacted",
      sql`${table.redactedAt} is not null or (${table.toAddress} is not null and ${table.fromAddress} is not null)`,
    ),
  ],
);

// Append-only history of text consent: opt-ins, unchecked boxes, opt-outs, START replies.
export const consentEvent = pgTable(
  "consent_event",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    applicationId: uuid().references(() => application.id),
    // So consent stays per employer when Midwest Access is added.
    employerId: uuid().references(() => employer.id),
    channel: channelEnum().notNull(),
    // E.164.
    address: text().notNull(),
    action: consentActionEnum().notNull(),
    method: consentMethodEnum().notNull(),
    // The version actually shown; required when method = web_form.
    legalTextVersionId: uuid().references(() => legalTextVersion.id),
    checkboxValue: boolean(),
    language: text(),
    ip: inet(),
    userAgent: text(),
    entryCodeId: uuid().references(() => entryCode.id),
    // The inbound message for keyword or free-text events.
    messageId: uuid().references(() => message.id),
    recordedBy: uuid().references(() => appUser.id),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("consent_event_address_employer_id_occurred_at_idx").on(table.address, table.employerId, table.occurredAt),
    index("consent_event_person_id_idx").on(table.personId),
    check(
      "consent_event_web_form_has_legal_text",
      sql`${table.method} <> 'web_form' or ${table.legalTextVersionId} is not null`,
    ),
  ],
);

// The source of truth for "do not send to this address", checked at send time.
// Global across employers on purpose; rows are never purged.
export const suppression = pgTable(
  "suppression",
  {
    id: id(),
    channel: channelEnum().notNull(),
    // E.164 or normalized email.
    address: text().notNull(),
    reason: suppressionReasonEnum().notNull(),
    // The inbound text or bounce that caused it. The one FK in the schema that does not restrict.
    messageId: uuid().references(() => message.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => appUser.id),
    liftedAt: timestamptz(),
    liftReason: text(),
    liftedBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("suppression_one_live_per_address").on(table.channel, table.address).where(sql`lifted_at is null`),
  ],
);

// Reusable link tokens, stored only as SHA-256 hashes. Minted inside the send function.
export const resumeToken = pgTable(
  "resume_token",
  {
    id: id(),
    applicationId: uuid()
      .notNull()
      .references(() => application.id),
    tokenHash: bytea().notNull(),
    issuedVia: tokenIssueEnum().notNull(),
    // The message that carried it.
    messageId: uuid().references(() => message.id),
    // Sliding: last use plus 30 days.
    expiresAt: timestamptz().notNull(),
    lastUsedAt: timestamptz(),
    revokedAt: timestamptz(),
    revokedBy: uuid().references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("resume_token_token_hash_unique").on(table.tokenHash),
    index("resume_token_application_id_idx").on(table.applicationId),
  ],
);
