"use server";

import { z } from "zod";
import { sourceKey, sourceTakesDetail } from "@/components/applicant/sources";
import { db } from "@/db";
import { resolveEntryCode } from "@/server/services/entry-codes";
import { isPlausibleEmail, landApplicant, LandingError, normalizeUsMobile, suggestEmail } from "@/server/services/landing";
import { getProviders } from "@/server/services/messaging/providers";
import { processMessages, SendError } from "@/server/services/messaging/send";
import { requestContext } from "./request";
import { currentApplicationId, setApplicantCookie } from "./session";
import { TURNSTILE_FIELD, verifyTurnstile } from "./turnstile";

// The landing form (PLAN.md, "What a snow applicant experiences"). The action
// validates inline, lands the applicant, sends the link inside the request, sets
// the session cookie and tells the page to continue to /apply with a full page
// load. Duplicate, conflict and rate-limit outcomes become the neutral screens.

export type LandFieldErrors = Partial<Record<"firstName" | "lastName" | "mobile" | "email" | "form", string>>;

export type LandState =
  | { status: "idle" }
  | { status: "errors"; errors: LandFieldErrors; emailSuggestion?: string | null }
  | { status: "created"; textsBlocked: boolean }
  | { status: "check_messages" }
  | { status: "rate_limited" }
  | { status: "not_open" };

const fields = z.object({
  code: z.string().trim().min(1).max(16),
  consentVersionId: z.string().uuid(),
  firstName: z.string().trim().max(100),
  lastName: z.string().trim().max(100),
  mobile: z.string().trim().max(40),
  email: z.string().trim().max(254),
  source: z.string().trim().max(40).optional(),
  sourceDetail: z.string().trim().max(200).optional(),
  textConsent: z.string().optional(),
  turnstile: z.string().max(4000).optional(),
});

export async function landAction(_previous: LandState, formData: FormData): Promise<LandState> {
  const parsed = fields.safeParse({
    code: formData.get("code"),
    consentVersionId: formData.get("consentVersionId"),
    firstName: formData.get("firstName") ?? "",
    lastName: formData.get("lastName") ?? "",
    mobile: formData.get("mobile") ?? "",
    email: formData.get("email") ?? "",
    source: formData.get("source") ?? undefined,
    sourceDetail: formData.get("sourceDetail") ?? undefined,
    textConsent: formData.get("textConsent") ?? undefined,
    turnstile: formData.get(TURNSTILE_FIELD) ?? undefined,
  });
  if (!parsed.success) return { status: "errors", errors: { form: "Something in the form did not come through. Reload the page and try again." } };
  const input = parsed.data;

  const errors: LandFieldErrors = {};
  if (!input.firstName) errors.firstName = "Enter your first name";
  if (!input.lastName) errors.lastName = "Enter your last name";
  const mobile = normalizeUsMobile(input.mobile);
  if (!mobile) errors.mobile = "Enter a US mobile number, like 612-555-0123";
  if (!isPlausibleEmail(input.email)) errors.email = "Enter an email address, like you@example.com";
  if (Object.keys(errors).length > 0) {
    return { status: "errors", errors, emailSuggestion: errors.email ? null : suggestEmail(input.email) };
  }

  const resolution = await resolveEntryCode(db, input.code);
  if (resolution.status === "not_found") return { status: "errors", errors: { form: "This link is not active." } };
  if (!resolution.opening) return { status: "not_open" };

  const { ip, userAgent } = await requestContext();
  if (!(await verifyTurnstile(input.turnstile, ip))) {
    return { status: "errors", errors: { form: "We could not confirm you are a person. Please try again." } };
  }

  const source = sourceKey(input.source);
  const sourceDetail = sourceTakesDetail(source) ? input.sourceDetail?.trim() || null : null;

  try {
    const result = await landApplicant(db, {
      openingId: resolution.opening.id,
      entryCodeId: resolution.entryCode.id,
      entryChannel: resolution.entryCode.channel,
      scannedSessionId: resolution.status === "open" ? (resolution.session?.id ?? null) : null,
      firstName: input.firstName,
      lastName: input.lastName,
      mobile: input.mobile,
      email: input.email,
      source,
      sourceDetail,
      textConsent: { checked: input.textConsent === "on", legalTextVersionId: input.consentVersionId },
      ip,
      userAgent,
    });

    // The link goes out inside the request; a provider failure never blocks the applicant.
    try {
      await processMessages(db, result.queued, getProviders());
    } catch (error) {
      console.error("[landing] sending the link failed", error);
    }

    if (result.outcome === "created") {
      await setApplicantCookie(result.applicationId);
      return { status: "created", textsBlocked: result.textsBlocked };
    }
    if (result.outcome === "resent") {
      // A retried submit from a device that already holds this application's cookie continues it.
      if ((await currentApplicationId()) === result.applicationId) return { status: "created", textsBlocked: result.textsBlocked };
      return { status: "check_messages" };
    }
    return { status: "check_messages" };
  } catch (error) {
    if (error instanceof SendError && error.code === "link_rate_limited") return { status: "rate_limited" };
    if (error instanceof LandingError) {
      switch (error.code) {
        case "invalid_mobile":
          return { status: "errors", errors: { mobile: "Enter a US mobile number, like 612-555-0123" } };
        case "invalid_email":
          return { status: "errors", errors: { email: "Enter an email address, like you@example.com" } };
        case "name_required":
          return { status: "errors", errors: { firstName: "Enter your first and last name" } };
        case "opening_not_open":
          return { status: "not_open" };
        case "consent_text_invalid":
          return { status: "errors", errors: { form: "This page is out of date. Reload it and try again." } };
      }
    }
    console.error("[landing] failed", error);
    return { status: "errors", errors: { form: "Something went wrong on our side. Please try again." } };
  }
}
