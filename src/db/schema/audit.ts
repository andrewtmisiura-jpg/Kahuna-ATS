import { index, inet, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./auth";
import { id, timestamptz } from "./columns";
import { actorTypeEnum } from "./enums";
import { application, person } from "./people";

export type AuditChanges = Record<string, unknown>;

// Edits, exports, permission changes, config publishes, merges, legal holds and
// retention strips. Append-only (trigger). Stage changes live in application_event.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    occurredAt: timestamptz().notNull(),
    actorType: actorTypeEnum().notNull(),
    actorUserId: uuid().references(() => appUser.id),
    // e.g. person.update, application.source_change, user.role_grant, config.publish, export.run
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    personId: uuid().references(() => person.id),
    applicationId: uuid().references(() => application.id),
    // {field: {from, to}}; PII fields are recorded as "[changed]", never values.
    changes: jsonb().$type<AuditChanges>(),
    requestId: text(),
    ip: inet(),
  },
  (table) => [
    index("audit_log_entity_type_entity_id_occurred_at_idx").on(table.entityType, table.entityId, table.occurredAt),
    index("audit_log_application_id_occurred_at_idx").on(table.applicationId, table.occurredAt),
    index("audit_log_actor_user_id_occurred_at_idx").on(table.actorUserId, table.occurredAt),
  ],
);
