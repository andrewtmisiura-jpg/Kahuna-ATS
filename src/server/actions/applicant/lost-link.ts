"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { application, person, role } from "@/db/schema";
import { APPLICANT_ACTOR } from "@/server/services/actor";
import { isPlausibleEmail, normalizeUsMobile } from "@/server/services/landing";
import { isOptedIn, latestConsent } from "@/server/services/messaging/consent";
import { getProviders } from "@/server/services/messaging/providers";
import { processMessages, queueMessage, SendError } from "@/server/services/messaging/send";
import { normalizeEmail } from "@/server/services/users";
import { requestContext } from "./request";
import { TURNSTILE_FIELD, verifyTurnstile } from "./turnstile";

// The lost-link page: mobile plus email, always the same neutral answer, and a
// link_recovery message only when both match one person with an application.

export type LostLinkErrors = Partial<Record<"mobile" | "email" | "form", string>>;

export type LostLinkState = { status: "idle" } | { status: "errors"; errors: LostLinkErrors } | { status: "sent" };

const fields = z.object({
  mobile: z.string().trim().max(40),
  email: z.string().trim().max(254),
  turnstile: z.string().max(4000).optional(),
});

export async function lostLinkAction(_previous: LostLinkState, formData: FormData): Promise<LostLinkState> {
  const parsed = fields.safeParse({
    mobile: formData.get("mobile") ?? "",
    email: formData.get("email") ?? "",
    turnstile: formData.get(TURNSTILE_FIELD) ?? undefined,
  });
  if (!parsed.success) return { status: "errors", errors: { form: "Reload the page and try again." } };

  const errors: LostLinkErrors = {};
  const mobile = normalizeUsMobile(parsed.data.mobile);
  if (!mobile) errors.mobile = "Enter a US mobile number, like 612-555-0123";
  if (!isPlausibleEmail(parsed.data.email)) errors.email = "Enter an email address, like you@example.com";
  if (Object.keys(errors).length > 0) return { status: "errors", errors };

  const { ip } = await requestContext();
  if (!(await verifyTurnstile(parsed.data.turnstile, ip))) {
    return { status: "errors", errors: { form: "We could not confirm you are a person. Please try again." } };
  }

  try {
    const match = await findApplication(mobile!, normalizeEmail(parsed.data.email));
    if (match) {
      const common = { employerId: match.employerId, personId: match.personId, applicationId: match.applicationId, triggeredBy: APPLICANT_ACTOR } as const;
      const queued: string[] = [];
      queued.push((await queueMessage(db, { ...common, channel: "email", content: { purpose: "link_recovery" } })).messageId);
      if (isOptedIn(await latestConsent(db, mobile!, match.employerId))) {
        queued.push((await queueMessage(db, { ...common, channel: "sms", content: { purpose: "link_recovery" } })).messageId);
      }
      await processMessages(db, queued, getProviders());
    }
  } catch (error) {
    // Rate limits and provider failures show the same neutral screen; nothing leaks.
    if (!(error instanceof SendError)) console.error("[lost-link] failed", error);
  }
  return { status: "sent" };
}

// Both details must point at the same person; a shared phone matches by email, so
// the email check covers it. The newest application wins when there are several.
async function findApplication(mobile: string, emailNormalized: string) {
  const people = await db
    .select({ id: person.id, mergedInto: person.mergedIntoPersonId })
    .from(person)
    .where(and(eq(person.mobileE164, mobile), eq(person.emailNormalized, emailNormalized), isNull(person.deletedAt)));
  if (people.length === 0) return null;
  const personId = people[0]!.mergedInto ?? people[0]!.id;
  const [app] = await db
    .select({ applicationId: application.id, personId: application.personId, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(and(eq(application.personId, personId), isNull(application.deletedAt)))
    .orderBy(desc(application.createdAt))
    .limit(1);
  return app ?? null;
}
