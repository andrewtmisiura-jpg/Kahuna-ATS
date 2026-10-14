import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { Db } from "@/db";
import { application, landingConflict, legalTextVersion, opening, person, role } from "@/db/schema";
import { PHONE_US_PATTERN } from "@/db/schema/columns";
import { uuidv7 } from "@/lib/uuid";
import { APPLICANT_ACTOR } from "./actor";
import { createApplication } from "./applications/transition";
import { recordConsent, liveSuppression } from "./messaging/consent";
import { queueMessage } from "./messaging/send";
import { normalizeEmail } from "./users";

// The landing form (DATA_MODEL.md, "Landing matching"): match by mobile, then
// email, never names; the public form never changes contact details on file;
// a matched person with an application on this opening gets the link resent and
// a neutral screen; any mismatch becomes a landing_conflict for staff.

type PersonRow = typeof person.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const PHONE_US = new RegExp(PHONE_US_PATTERN);

// E.164 for a valid US mobile typed any common way, else null.
export function normalizeUsMobile(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), "US");
  if (!parsed || !parsed.isValid() || parsed.country !== "US") return null;
  return PHONE_US.test(parsed.number) ? parsed.number : null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isPlausibleEmail(input: string): boolean {
  return EMAIL_SHAPE.test(input.trim()) && input.trim().length <= 254;
}

const COMMON_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "comcast.net",
  "protonmail.com",
  "me.com",
];

// "Did you mean ana@gmail.com?" for a domain one or two keystrokes off a common
// one. Never applied automatically: the form offers it, the applicant decides.
export function suggestEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (COMMON_DOMAINS.includes(domain)) return null;
  let best: { domain: string; distance: number } | null = null;
  for (const candidate of COMMON_DOMAINS) {
    const distance = editDistance(domain, candidate);
    if (distance <= 2 && (!best || distance < best.distance)) best = { domain: candidate, distance };
  }
  return best ? `${local}@${best.domain}` : null;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length]!;
}

export type LandingInput = {
  openingId: string;
  entryCodeId?: string | null;
  entryChannel: (typeof application.$inferSelect)["entryChannel"];
  scannedSessionId?: string | null;
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  source?: (typeof application.$inferSelect)["source"] | null;
  sourceDetail?: string | null;
  // The consent box, with the exact text version the form showed (hidden field).
  textConsent: { checked: boolean; legalTextVersionId: string };
  ip?: string | null;
  userAgent?: string | null;
  language?: string;
  now?: Date;
};

export type LandingErrorCode = "invalid_mobile" | "invalid_email" | "name_required" | "opening_not_open" | "consent_text_invalid";

export class LandingError extends Error {
  constructor(
    readonly code: LandingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LandingError";
  }
}

export type LandingResult =
  // A new application: the applicant goes straight into the form.
  | { outcome: "created"; applicationId: string; personId: string; newPerson: boolean; textsBlocked: boolean; queued: string[] }
  // The same person already applied here: the link goes to the details on file, the page is neutral.
  | { outcome: "resent"; applicationId: string; personId: string; textsBlocked: boolean; queued: string[] }
  // Mobile and email point at different people: nothing is created for the typist.
  | { outcome: "conflict"; conflictId: string; applicationId: string | null; queued: string[] };

export async function landApplicant(db: Db, input: LandingInput): Promise<LandingResult> {
  const now = input.now ?? new Date();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName) throw new LandingError("name_required", "First and last name are required");
  const mobile = normalizeUsMobile(input.mobile);
  if (!mobile) throw new LandingError("invalid_mobile", "Enter a valid US mobile number");
  const email = input.email.trim();
  if (!isPlausibleEmail(email)) throw new LandingError("invalid_email", "Enter a valid email address");
  const emailNormalized = normalizeEmail(email);

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({ id: opening.id, roleId: opening.roleId, status: opening.status, employerId: role.employerId })
      .from(opening)
      .innerJoin(role, eq(role.id, opening.roleId))
      .where(eq(opening.id, input.openingId));
    if (!open || open.status !== "open") throw new LandingError("opening_not_open", "This opening is not accepting applications");
    await assertConsentText(tx, input.textConsent.legalTextVersionId, open.employerId);

    const byMobile = await matchByMobile(tx, mobile);
    const byEmail = await matchByEmail(tx, emailNormalized);
    const queued: string[] = [];

    const consent = async (personId: string, applicationId: string | null) => {
      await recordConsent(tx, {
        personId,
        applicationId,
        employerId: open.employerId,
        channel: "sms",
        address: mobile,
        action: input.textConsent.checked ? "opt_in" : "declined",
        method: "web_form",
        legalTextVersionId: input.textConsent.legalTextVersionId,
        checkboxValue: input.textConsent.checked,
        language: input.language ?? "en",
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        entryCodeId: input.entryCodeId ?? null,
        occurredAt: now,
      });
      // A web opt-in never lifts a suppression; the page tells them to text START.
      return input.textConsent.checked && Boolean(await liveSuppression(tx, "sms", mobile));
    };

    const sendLinks = async (personId: string, applicationId: string, purpose: "resume_link" | "link_recovery", textsToo: boolean) => {
      const common = { employerId: open.employerId, personId, applicationId, triggeredBy: APPLICANT_ACTOR, now } as const;
      // Both go out: the email always, the text only when the box was ticked. The
      // send function still checks consent, suppression and the texting switch.
      queued.push((await queueMessage(tx, { ...common, channel: "email", content: { purpose } })).messageId);
      if (textsToo) queued.push((await queueMessage(tx, { ...common, channel: "sms", content: { purpose } })).messageId);
    };

    // Which person the typist is, if the rules allow one.
    let matched: PersonRow | null = null;
    let createPerson = false;
    let sharedMobile = false;
    if (byMobile.shared) {
      // A shared phone matches by email only; no email match creates a new person on the shared number.
      if (byEmail.length === 1) matched = byEmail[0]!;
      else if (byEmail.length === 0) {
        createPerson = true;
        sharedMobile = true;
      }
    } else if (!byMobile.person && byEmail.length === 0) {
      createPerson = true;
    } else if (byMobile.person && byEmail.length === 1 && byEmail[0]!.id === byMobile.person.id) {
      matched = byMobile.person;
    }

    if (!matched && !createPerson) {
      return writeConflict(tx, input, open, mobile, email, byMobile.person, byEmail, sendLinks, queued, now);
    }

    let who: PersonRow;
    let newPerson = false;
    if (matched) {
      who = matched;
      // Serialises two simultaneous landings by the same person.
      await tx.select({ id: person.id }).from(person).where(eq(person.id, who.id)).for("update");
    } else {
      const result = await insertPerson(tx, { firstName, lastName, mobile, email, emailNormalized, sharedMobile, now });
      who = result.person;
      newPerson = result.created;
    }

    const [existing] = await tx
      .select({ id: application.id })
      .from(application)
      .where(and(eq(application.personId, who.id), eq(application.openingId, open.id), isNull(application.deletedAt)));
    if (existing) {
      const textsBlocked = await consent(who.id, existing.id);
      await sendLinks(who.id, existing.id, "link_recovery", input.textConsent.checked);
      return { outcome: "resent", applicationId: existing.id, personId: who.id, textsBlocked, queued };
    }

    const { applicationId } = await createApplication(tx, {
      personId: who.id,
      openingId: open.id,
      origin: "landing",
      entryCodeId: input.entryCodeId ?? null,
      entryChannel: input.entryChannel,
      scannedSessionId: input.scannedSessionId ?? null,
      source: input.source ?? null,
      sourceDetail: input.sourceDetail ?? null,
      language: input.language,
      actor: APPLICANT_ACTOR,
      now,
    });
    const textsBlocked = await consent(who.id, applicationId);
    await sendLinks(who.id, applicationId, "resume_link", input.textConsent.checked);
    return { outcome: "created", applicationId, personId: who.id, newPerson, textsBlocked, queued };
  });
}

async function writeConflict(
  tx: Tx,
  input: LandingInput,
  open: { id: string },
  mobile: string,
  email: string,
  mobilePerson: PersonRow | null,
  emailPeople: PersonRow[],
  sendLinks: (personId: string, applicationId: string, purpose: "link_recovery", textsToo: boolean) => Promise<void>,
  queued: string[],
  now: Date,
): Promise<LandingResult> {
  const matchedIds = [...new Set([mobilePerson?.id, ...emailPeople.map((p) => p.id)].filter((id): id is string => Boolean(id)))];
  const conflictId = uuidv7();
  await tx.insert(landingConflict).values({
    id: conflictId,
    openingId: open.id,
    entryCodeId: input.entryCodeId ?? null,
    typedFirstName: input.firstName.trim(),
    typedLastName: input.lastName.trim(),
    typedMobileE164: mobile,
    typedEmail: email,
    matchedPersonIds: matchedIds,
    createdAt: now,
  });

  // The mobile's person gets their own link if they already applied here; the typist learns nothing.
  let applicationId: string | null = null;
  if (mobilePerson) {
    const [existing] = await tx
      .select({ id: application.id })
      .from(application)
      .where(and(eq(application.personId, mobilePerson.id), eq(application.openingId, open.id), isNull(application.deletedAt)));
    if (existing) {
      applicationId = existing.id;
      await sendLinks(mobilePerson.id, existing.id, "link_recovery", true);
    }
  }
  return { outcome: "conflict", conflictId, applicationId, queued };
}

async function assertConsentText(tx: Tx, legalTextVersionId: string, employerId: string) {
  const [row] = await tx
    .select({ id: legalTextVersion.id })
    .from(legalTextVersion)
    .where(
      and(
        eq(legalTextVersion.id, legalTextVersionId),
        eq(legalTextVersion.employerId, employerId),
        eq(legalTextVersion.kind, "sms_consent"),
      ),
    );
  if (!row) throw new LandingError("consent_text_invalid", "The consent text version is not one of ours");
  const [published] = await tx
    .select({ publishedAt: legalTextVersion.publishedAt })
    .from(legalTextVersion)
    .where(eq(legalTextVersion.id, legalTextVersionId));
  if (!published?.publishedAt) throw new LandingError("consent_text_invalid", "The consent text version is not published");
}

// Follows merged_into_person_id to the root.
async function rootOf(tx: Tx, row: PersonRow): Promise<PersonRow> {
  let current = row;
  for (let hops = 0; current.mergedIntoPersonId && hops < 10; hops++) {
    const [parent] = await tx.select().from(person).where(eq(person.id, current.mergedIntoPersonId));
    if (!parent) break;
    current = parent;
  }
  return current;
}

async function matchByMobile(tx: Tx, mobile: string): Promise<{ person: PersonRow | null; shared: boolean }> {
  const rows = await tx
    .select()
    .from(person)
    .where(and(eq(person.mobileE164, mobile), isNull(person.deletedAt)));
  if (rows.some((p) => p.sharedMobile)) return { person: null, shared: true };
  return { person: rows[0] ? await rootOf(tx, rows[0]) : null, shared: false };
}

async function matchByEmail(tx: Tx, emailNormalized: string): Promise<PersonRow[]> {
  const rows = await tx
    .select()
    .from(person)
    .where(and(eq(person.emailNormalized, emailNormalized), isNull(person.deletedAt)));
  const roots = new Map<string, PersonRow>();
  for (const row of rows) {
    const root = await rootOf(tx, row);
    roots.set(root.id, root);
  }
  return [...roots.values()];
}

// insert ... on conflict do nothing and re-select, so two simultaneous first
// requests from one phone never return an error.
async function insertPerson(
  tx: Tx,
  input: { firstName: string; lastName: string; mobile: string; email: string; emailNormalized: string; sharedMobile: boolean; now: Date },
): Promise<{ person: PersonRow; created: boolean }> {
  const values = {
    id: uuidv7(),
    firstName: input.firstName,
    lastName: input.lastName,
    mobileE164: input.mobile,
    email: input.email,
    emailNormalized: input.emailNormalized,
    sharedMobile: input.sharedMobile,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const inserted = input.sharedMobile
    ? await tx.insert(person).values(values).returning()
    : await tx
        .insert(person)
        .values(values)
        // The predicate must match person_one_per_unshared_mobile for Postgres to pick the index.
        .onConflictDoNothing({ target: person.mobileE164, where: sql`mobile_e164 is not null and not shared_mobile` })
        .returning();
  if (inserted[0]) return { person: inserted[0], created: true };
  const again = await matchByMobile(tx, input.mobile);
  if (!again.person) throw new Error("person insert conflicted but no row matches the mobile");
  return { person: again.person, created: false };
}
