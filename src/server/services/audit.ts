import type { Db } from "@/db";
import { auditLog, type AuditChanges } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { actorColumns, type Actor } from "./actor";

// The one writer of audit_log rows (DATA_MODEL.md, audit_log): edits, exports,
// permission changes, config publishes, merges, legal holds and retention strips.
// Stage changes are not copied here; application_event already has actor and time.

export type AuditInput = {
  actor: Actor;
  // e.g. person.update, application.source_change, user.role_grant, config.publish, export.run
  action: string;
  entityType: string;
  entityId: string;
  personId?: string | null;
  applicationId?: string | null;
  changes?: AuditChanges | null;
  requestId?: string | null;
  ip?: string | null;
  occurredAt?: Date;
};

export async function writeAudit(db: Db, input: AuditInput): Promise<string> {
  const id = uuidv7();
  await db.insert(auditLog).values({
    id,
    occurredAt: input.occurredAt ?? new Date(),
    ...actorColumns(input.actor),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    personId: input.personId ?? null,
    applicationId: input.applicationId ?? null,
    changes: input.changes ?? null,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
  });
  return id;
}

export const CHANGED = "[changed]";

// Builds the {field: {from, to}} shape for the fields that differ. Fields listed in
// `pii` are recorded as "[changed]" on both sides, never their values.
export function diffChanges<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
  pii: readonly (keyof T & string)[] = [],
): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of fields) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (sameValue(from, to)) continue;
    changes[field] = pii.includes(field) ? { from: CHANGED, to: CHANGED } : { from, to };
  }
  return changes;
}

function sameValue(a: unknown, b: unknown) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
