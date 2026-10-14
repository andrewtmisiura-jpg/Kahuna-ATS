import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { application, landingConflict, message, person, role } from "@/db/schema";
import { staffActor } from "./actor";
import { diffChanges, writeAudit } from "./audit";
import { isPlausibleEmail, normalizeUsMobile } from "./landing";
import { recordStaffOptOut } from "./messaging/consent";
import { getProviders } from "./messaging/providers";
import type { Providers } from "./messaging/providers/types";
import { processMessages, queueMessage } from "./messaging/send";
import { revokeApplicationTokens } from "./tokens";
import { normalizeEmail } from "./users";

// Staff edits to a person and the housekeeping actions on the profile
// (DATA_MODEL.md, person and application): contact edits audited with values
// recorded as "[changed]", the shared-phone flag, do-not-contact, "they asked
// me to stop", landing conflicts and the Admin-only test-application delete.

export type PersonErrorCode =
  | "person_not_found"
  | "application_not_found"
  | "conflict_not_found"
  | "name_required"
  | "invalid_mobile"
  | "invalid_email"
  | "mobile_in_use"
  | "no_mobile"
  | "no_address"
  | "message_not_found"
  | "already_resolved";

export class PersonError extends Error {
  constructor(
    readonly code: PersonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersonError";
  }
}

type PersonRow = typeof person.$inferSelect;

async function loadPerson(db: Db, personId: string): Promise<PersonRow> {
  const [row] = await db.select().from(person).where(eq(person.id, personId));
  if (!row || row.deletedAt) throw new PersonError("person_not_found", "No such person");
  return row;
}

export type ContactInput = {
  personId: string;
  userId: string;
  firstName: string;
  lastName: string;
  mobile: string | null;
  email: string | null;
  sharedMobile: boolean;
  now?: Date;
};

const CONTACT_FIELDS = ["firstName", "lastName", "mobileE164", "email", "sharedMobile"] as const;
const CONTACT_PII = ["firstName", "lastName", "mobileE164", "email"] as const;

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e?.cause?.code ?? e?.code) === "23505";
}

export async function updateContact(db: Db, input: ContactInput): Promise<{ changed: string[] }> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName) throw new PersonError("name_required", "First and last name are required");
  let mobile: string | null = null;
  if (input.mobile?.trim()) {
    mobile = normalizeUsMobile(input.mobile);
    if (!mobile) throw new PersonError("invalid_mobile", "Enter a valid US mobile number");
  }
  let email: string | null = null;
  if (input.email?.trim()) {
    email = input.email.trim();
    if (!isPlausibleEmail(email)) throw new PersonError("invalid_email", "Enter a valid email address");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const before = await loadPerson(tx, input.personId);
    const after = { ...before, firstName, lastName, mobileE164: mobile, email, emailNormalized: email ? normalizeEmail(email) : null, sharedMobile: input.sharedMobile };
    const changes = diffChanges(before, after, CONTACT_FIELDS, CONTACT_PII);
    if (Object.keys(changes).length === 0) return { changed: [] };
    try {
      await tx
        .update(person)
        .set({ firstName, lastName, mobileE164: mobile, email, emailNormalized: after.emailNormalized, sharedMobile: input.sharedMobile, updatedAt: now })
        .where(eq(person.id, before.id));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PersonError("mobile_in_use", "Another person already has that mobile number. Mark the phone as shared if two people really share it.");
      }
      throw error;
    }
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "person.update",
      entityType: "person",
      entityId: before.id,
      personId: before.id,
      changes,
      occurredAt: now,
    });
    return { changed: Object.keys(changes) };
  });
}

export async function setDoNotContact(db: Db, input: { personId: string; userId: string; value: boolean; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const before = await loadPerson(tx, input.personId);
    if (before.doNotContact === input.value) return;
    await tx.update(person).set({ doNotContact: input.value, updatedAt: now }).where(eq(person.id, before.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "person.do_not_contact",
      entityType: "person",
      entityId: before.id,
      personId: before.id,
      changes: { doNotContact: { from: before.doNotContact, to: input.value } },
      occurredAt: now,
    });
  });
}

// "They asked me to stop": a staff-recorded text opt-out for the number on file.
export async function recordStopRequest(
  db: Db,
  input: { applicationId: string; userId: string; now?: Date },
): Promise<{ consentEventId: string; suppressionId: string }> {
  const [app] = await db
    .select({ id: application.id, personId: application.personId, deletedAt: application.deletedAt, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(eq(application.id, input.applicationId));
  if (!app || app.deletedAt) throw new PersonError("application_not_found", "No such application");
  const who = await loadPerson(db, app.personId);
  if (!who.mobileE164) throw new PersonError("no_mobile", "This person has no mobile number on file");
  return db.transaction((tx) =>
    recordStaffOptOut(tx, {
      personId: who.id,
      applicationId: app.id,
      employerId: app.employerId,
      address: who.mobileE164!,
      userId: input.userId,
      reason: "staff_marked",
      now: input.now,
    }),
  );
}

export async function updateIndeedAppliedOn(
  db: Db,
  input: { applicationId: string; userId: string; date: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [app] = await tx.select().from(application).where(eq(application.id, input.applicationId));
    if (!app || app.deletedAt) throw new PersonError("application_not_found", "No such application");
    if (app.indeedAppliedOn === input.date) return;
    await tx.update(application).set({ indeedAppliedOn: input.date, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "application.indeed_applied_on",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      changes: { indeedAppliedOn: { from: app.indeedAppliedOn, to: input.date } },
      occurredAt: now,
    });
  });
}

export type ConflictResolution = "update_email" | "mark_shared";

// The two buttons on the contact-conflict banner (DATA_MODEL.md, landing_conflict).
export async function resolveLandingConflict(
  db: Db,
  input: { conflictId: string; personId: string; resolution: ConflictResolution; userId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [conflict] = await tx.select().from(landingConflict).where(eq(landingConflict.id, input.conflictId));
    if (!conflict) throw new PersonError("conflict_not_found", "No such conflict");
    if (conflict.resolvedAt) throw new PersonError("already_resolved", "Someone already resolved this");
    if (!conflict.matchedPersonIds.includes(input.personId)) throw new PersonError("person_not_found", "That person is not part of this conflict");
    const who = await loadPerson(tx, input.personId);

    if (input.resolution === "update_email") {
      if (!conflict.typedEmail || !isPlausibleEmail(conflict.typedEmail)) throw new PersonError("invalid_email", "The typed email is not usable");
      await updateContact(tx, {
        personId: who.id,
        userId: input.userId,
        firstName: who.firstName ?? "",
        lastName: who.lastName ?? "",
        mobile: who.mobileE164,
        email: conflict.typedEmail,
        sharedMobile: who.sharedMobile,
        now,
      });
    } else {
      await updateContact(tx, {
        personId: who.id,
        userId: input.userId,
        firstName: who.firstName ?? "",
        lastName: who.lastName ?? "",
        mobile: who.mobileE164,
        email: who.email,
        sharedMobile: true,
        now,
      });
    }
    await tx
      .update(landingConflict)
      .set({
        resolvedAt: now,
        resolvedBy: input.userId,
        resolution: input.resolution === "update_email" ? "updated email on file" : "marked phone shared",
      })
      .where(eq(landingConflict.id, conflict.id));
  });
}

// Inbound triage: the "Mark handled" button beside a text on the profile.
export async function markTextHandled(db: Db, input: { messageId: string; userId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(message)
    .set({ handledAt: now, handledBy: input.userId, updatedAt: now })
    .where(and(eq(message.id, input.messageId), eq(message.direction, "inbound"), isNull(message.handledAt)))
    .returning({ id: message.id });
  if (rows.length === 0) {
    const [existing] = await db.select({ id: message.id }).from(message).where(eq(message.id, input.messageId));
    if (!existing) throw new PersonError("message_not_found", "No such message");
  }
}

export type ResendLinkResult = { queued: string[]; sent: string[]; suppressed: string[]; revoked: number };

// "Resend link" and "Revoke link": a fresh link_recovery message by email and, when
// the person has a number, by text (the send function still applies every rule).
// Revoking kills every live token of the application first (DATA_MODEL.md, resume_token).
export async function resendApplicationLink(
  db: Db,
  input: { applicationId: string; userId: string; revokeFirst?: boolean; providers?: Providers; now?: Date },
): Promise<ResendLinkResult> {
  const now = input.now ?? new Date();
  const [app] = await db
    .select({ id: application.id, personId: application.personId, deletedAt: application.deletedAt, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(eq(application.id, input.applicationId));
  if (!app || app.deletedAt) throw new PersonError("application_not_found", "No such application");
  const who = await loadPerson(db, app.personId);
  if (!who.email && !who.mobileE164) throw new PersonError("no_address", "This person has no email or mobile number on file");

  const queued = await db.transaction(async (tx) => {
    const revoked = input.revokeFirst ? await revokeApplicationTokens(tx, { applicationId: app.id, revokedBy: input.userId, now }) : 0;
    const ids: string[] = [];
    const common = { employerId: app.employerId, personId: who.id, applicationId: app.id, triggeredBy: staffActor(input.userId), now } as const;
    if (who.email) ids.push((await queueMessage(tx, { ...common, channel: "email", content: { purpose: "link_recovery" } })).messageId);
    if (who.mobileE164) ids.push((await queueMessage(tx, { ...common, channel: "sms", content: { purpose: "link_recovery" } })).messageId);
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: input.revokeFirst ? "application.link_revoke" : "application.link_resend",
      entityType: "application",
      entityId: app.id,
      personId: who.id,
      applicationId: app.id,
      changes: { revoked_tokens: revoked, message_ids: ids },
      occurredAt: now,
    });
    return { ids, revoked };
  });
  const summary = await processMessages(db, queued.ids, input.providers ?? getProviders(), now);
  return { queued: queued.ids, sent: summary.sent, suppressed: summary.suppressed, revoked: queued.revoked };
}

// Admin only: the soft delete behind "Delete test application". Deleted rows are
// out of every count and report; the audit row says who and when.
export async function deleteTestApplication(db: Db, input: { applicationId: string; userId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [app] = await tx
      .select({ id: application.id, personId: application.personId })
      .from(application)
      .where(and(eq(application.id, input.applicationId), isNull(application.deletedAt)))
      .for("update");
    if (!app) throw new PersonError("application_not_found", "No such application");
    await tx.update(application).set({ deletedAt: now, updatedAt: now }).where(eq(application.id, app.id));
    await writeAudit(tx, {
      actor: staffActor(input.userId),
      action: "application.delete_test",
      entityType: "application",
      entityId: app.id,
      personId: app.personId,
      applicationId: app.id,
      occurredAt: now,
    });
  });
}
