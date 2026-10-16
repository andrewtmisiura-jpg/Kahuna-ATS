import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { PHASE2_TEMPLATES } from "@/db/changes/phase2-templates";
import { employer, interview, legalTextVersion, messageTemplate, person } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { createApplication, transition } from "@/server/services/applications/transition";
import { recordConsent } from "@/server/services/messaging/consent";
import { addMissingTemplates } from "@/server/services/messaging/templates";
import { createPerson, nextMobile, type SnowFixture } from "./fixtures";

// Rows the templates tests share. Test files share one database, so the Phase 2
// templates go in through the service the change uses, without an applied_change row
// (tests/db-changes.test.ts expects to apply every change itself), and every helper
// tolerates what an earlier file left behind.

export const PHONE_ID = "PNtest0001";
export const BOOKING_LINK = "https://book.example.com/kahuna-hiring/interview30";

export async function ensurePhase2Templates(db: Db, adminId: string): Promise<void> {
  await addMissingTemplates(db, { actor: staffActor(adminId), templates: PHASE2_TEMPLATES });
}

// The live employer-wide template for a purpose and channel.
export async function liveTemplate(db: Db, employerId: string, purpose: (typeof PHASE2_TEMPLATES)[number]["purpose"], channel: "sms" | "email") {
  const [row] = await db
    .select()
    .from(messageTemplate)
    .where(and(eq(messageTemplate.employerId, employerId), eq(messageTemplate.purpose, purpose), eq(messageTemplate.channel, channel)));
  return row!;
}

// Texting on and connected, and the booking link set, as in production after setup.
export async function readyEmployer(db: Db, employerId: string, values: Partial<typeof employer.$inferInsert> = {}) {
  await db
    .update(employer)
    .set({ smsEnabled: true, smsQuoPhoneNumberId: PHONE_ID, bookingLinkUrl: BOOKING_LINK, ...values })
    .where(eq(employer.id, employerId));
}

export async function resetEmployer(db: Db, employerId: string) {
  await db.update(employer).set({ smsEnabled: true, smsQuoPhoneNumberId: null, bookingLinkUrl: null }).where(eq(employer.id, employerId));
}

export type Applicant = { personId: string; applicationId: string; mobile: string | null; email: string | null };

// A submitted snow application, with a web-form text opt-in unless consent is "none" or "declined".
export async function submittedApplicant(
  db: Db,
  snow: SnowFixture,
  employerId: string,
  options: { consent?: "opt_in" | "declined" | "none"; person?: Partial<typeof person.$inferInsert>; at?: Date } = {},
): Promise<Applicant> {
  const mobile = options.person && "mobileE164" in options.person ? (options.person.mobileE164 ?? null) : nextMobile();
  const personId = await createPerson(db, { firstName: "Dana", ...options.person, mobileE164: mobile });
  const [row] = await db.select({ email: person.email }).from(person).where(eq(person.id, personId));
  const at = options.at ?? new Date(Date.now() - 2 * 3_600_000);
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: { type: "applicant" },
    occurredAt: at,
    now: at,
  });
  await transition(db, { action: "submit", applicationId, actor: { type: "applicant" }, occurredAt: at, now: at });
  const consent = options.consent ?? "opt_in";
  if (consent !== "none" && mobile) {
    const [legal] = await db.select({ id: legalTextVersion.id }).from(legalTextVersion).where(eq(legalTextVersion.kind, "sms_consent"));
    await recordConsent(db, {
      personId,
      applicationId,
      employerId,
      channel: "sms",
      address: mobile,
      action: consent,
      method: "web_form",
      legalTextVersionId: legal!.id,
      checkboxValue: consent === "opt_in",
      occurredAt: at,
    });
  }
  return { personId, applicationId, mobile, email: row!.email };
}

// A one-on-one, written straight to the table the way the interviews screens will.
export async function createInterview(db: Db, applicationId: string, values: Partial<typeof interview.$inferInsert> = {}): Promise<string> {
  const id = uuidv7();
  await db.insert(interview).values({ id, applicationId, kind: "one_on_one", status: "scheduled", ...values });
  return id;
}
