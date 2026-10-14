import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { consentEvent, suppression } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { normalizeEmail } from "../users";

// Text consent and the suppression list (DATA_MODEL.md, consent_event and
// suppression). Consent belongs to a number and an employer; suppression belongs
// to an address and is global across employers on purpose.

export type Channel = "sms" | "email";
export type ConsentRow = typeof consentEvent.$inferSelect;
export type SuppressionRow = typeof suppression.$inferSelect;

export function suppressionAddress(channel: Channel, address: string): string {
  return channel === "email" ? normalizeEmail(address) : address;
}

// The latest consent event for that number and employer, whatever its action.
export async function latestConsent(db: Db, address: string, employerId: string): Promise<ConsentRow | null> {
  const [row] = await db
    .select()
    .from(consentEvent)
    .where(and(eq(consentEvent.address, address), eq(consentEvent.employerId, employerId), eq(consentEvent.channel, "sms")))
    .orderBy(desc(consentEvent.occurredAt), desc(consentEvent.createdAt))
    .limit(1);
  return row ?? null;
}

export function isOptedIn(consent: ConsentRow | null): boolean {
  return consent?.action === "opt_in" || consent?.action === "opt_in_keyword";
}

export async function liveSuppression(db: Db, channel: Channel, address: string): Promise<SuppressionRow | null> {
  const [row] = await db
    .select()
    .from(suppression)
    .where(and(eq(suppression.channel, channel), eq(suppression.address, suppressionAddress(channel, address)), isNull(suppression.liftedAt)))
    .limit(1);
  return row ?? null;
}

// Adds a suppression unless one is already live. Returns the live row either way.
export async function suppress(
  db: Db,
  input: {
    channel: Channel;
    address: string;
    reason: SuppressionRow["reason"];
    messageId?: string | null;
    createdBy?: string | null;
    now?: Date;
  },
): Promise<SuppressionRow> {
  const existing = await liveSuppression(db, input.channel, input.address);
  if (existing) return existing;
  const [row] = await db
    .insert(suppression)
    .values({
      id: uuidv7(),
      channel: input.channel,
      address: suppressionAddress(input.channel, input.address),
      reason: input.reason,
      messageId: input.messageId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: input.now ?? new Date(),
    })
    .returning();
  return row!;
}

// Only START or UNSTOP from the number itself lifts a text suppression of any kind.
export async function liftByKeyword(db: Db, address: string, keyword: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(suppression)
    .set({ liftedAt: now, liftReason: `${keyword} keyword` })
    .where(and(eq(suppression.channel, "sms"), eq(suppression.address, address), isNull(suppression.liftedAt)))
    .returning({ id: suppression.id });
  return rows.length;
}

export class SuppressionLiftRefused extends Error {
  constructor(readonly reason: SuppressionRow["reason"]) {
    super(`A ${reason} suppression can only be lifted by the person texting START`);
    this.name = "SuppressionLiftRefused";
  }
}

// A staff lift with a recorded reason: never for stop_keyword or carrier_blocked,
// which Quo keeps blocking anyway.
export async function liftByStaff(
  db: Db,
  input: { suppressionId: string; userId: string; reason: string; now?: Date },
): Promise<SuppressionRow> {
  const [row] = await db.select().from(suppression).where(eq(suppression.id, input.suppressionId));
  if (!row) throw new Error("No such suppression");
  if (row.liftedAt) return row;
  if (row.reason === "stop_keyword" || row.reason === "carrier_blocked") throw new SuppressionLiftRefused(row.reason);
  const [updated] = await db
    .update(suppression)
    .set({ liftedAt: input.now ?? new Date(), liftReason: input.reason, liftedBy: input.userId })
    .where(eq(suppression.id, row.id))
    .returning();
  return updated!;
}

export async function recordConsent(
  db: Db,
  input: Omit<typeof consentEvent.$inferInsert, "id" | "createdAt">,
): Promise<string> {
  const id = uuidv7();
  await db.insert(consentEvent).values({ id, ...input });
  return id;
}

// The profile's one-click "they asked me to stop": a staff-recorded opt-out for
// that number, plus the matching suppression.
export async function recordStaffOptOut(
  db: Db,
  input: {
    personId: string;
    applicationId?: string | null;
    employerId: string;
    address: string;
    userId: string;
    reason?: "staff_marked" | "free_text_request";
    messageId?: string | null;
    now?: Date;
  },
): Promise<{ consentEventId: string; suppressionId: string }> {
  const now = input.now ?? new Date();
  const consentEventId = await recordConsent(db, {
    personId: input.personId,
    applicationId: input.applicationId ?? null,
    employerId: input.employerId,
    channel: "sms",
    address: input.address,
    action: "opt_out",
    method: input.reason === "free_text_request" ? "free_text_reply" : "staff_recorded",
    messageId: input.messageId ?? null,
    recordedBy: input.userId,
    occurredAt: now,
  });
  const row = await suppress(db, {
    channel: "sms",
    address: input.address,
    reason: input.reason ?? "staff_marked",
    messageId: input.messageId ?? null,
    createdBy: input.userId,
    now,
  });
  return { consentEventId, suppressionId: row.id };
}
