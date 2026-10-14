import { cookies } from "next/headers";
import { isProduction } from "@/config/env";
import { db } from "@/db";
import { mintResumeToken, TOKEN_TTL_DAYS, verifyResumeToken } from "@/server/services/tokens";

// The applicant's session is a resume token issued as a cookie (resume_token,
// issued_via landing_cookie): HttpOnly, Secure, SameSite=Lax, bound to one
// application, verified against its hash on every request. Revoking an
// application's tokens from the profile ends it like any link.

export const APPLICANT_COOKIE = "kahuna_application";

export type ApplicantCookie = {
  name: string;
  value: string;
  options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number };
};

export async function mintApplicantCookie(applicationId: string): Promise<ApplicantCookie> {
  const minted = await mintResumeToken(db, { applicationId, issuedVia: "landing_cookie" });
  return {
    name: APPLICANT_COOKIE,
    value: minted.token,
    options: {
      httpOnly: true,
      // Local development runs over http; everywhere else the cookie is Secure.
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
      maxAge: TOKEN_TTL_DAYS * 86_400,
    },
  };
}

// Server actions set the cookie through next/headers; route handlers set it on the response.
export async function setApplicantCookie(applicationId: string): Promise<void> {
  const cookie = await mintApplicantCookie(applicationId);
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
}

// The application the request's cookie is bound to, or null when there is no
// valid, unexpired, unrevoked token. Verifying slides the token's expiry.
export async function currentApplicationId(): Promise<string | null> {
  const token = (await cookies()).get(APPLICANT_COOKIE)?.value;
  if (!token) return null;
  const verified = await verifyResumeToken(db, token);
  return verified?.applicationId ?? null;
}
