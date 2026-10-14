import type { BetterAuthOptions } from "better-auth";
import { db } from "@/db";
import { checkGoogleSignIn, normalizeEmail, recordGoogleSignIn } from "@/server/services/users";

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;
type SessionCreateBefore = NonNullable<
  NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["create"]>["before"]
>;

export const SIGN_IN_REFUSED = "Ask an admin to add you";

// The allowlist is the app_user table: rows an Admin created in Settings > Users.
// Better Auth calls this before create-user, link-account and every Google sign-in.
// Returning nothing admits the identity; returning { error } refuses it.
export const validateAllowlistedUser: ValidateUserInfo = async ({ user, source }) => {
  const email = user.email ? normalizeEmail(user.email) : "";
  if (!email) {
    return { error: "email_required", errorDescription: SIGN_IN_REFUSED };
  }

  // Sign-in never creates a user. An email with no app_user row is refused and no row is written.
  if (source.action === "create-user") {
    return { error: "not_allowlisted", errorDescription: SIGN_IN_REFUSED };
  }
  if (source.method !== "oauth" || source.oauth?.providerId !== "google") {
    return { error: "google_only", errorDescription: "Sign in with Google" };
  }

  const profile = source.oauth.profile ?? {};
  const googleSub = typeof profile.sub === "string" ? profile.sub : undefined;
  // Better Auth maps Google's email_verified claim onto user.emailVerified.
  const emailVerified = user.emailVerified === true || profile.email_verified === true;

  const result = await checkGoogleSignIn(db, { email, emailVerified, googleSub });
  switch (result) {
    case "ok":
      return undefined;
    case "email_not_verified":
      return { error: "email_not_verified", errorDescription: "Your Google email is not verified" };
    case "google_sub_mismatch":
      return { error: "google_account_mismatch", errorDescription: "This email is bound to a different Google account" };
    default:
      return { error: result, errorDescription: SIGN_IN_REFUSED };
  }
};

// Runs before a database session row is written, so a disabled account can never
// obtain a fresh session; also binds google_sub on the first sign-in and stamps
// last_sign_in_at. Returning false aborts the sign-in.
export const beforeSessionCreate: SessionCreateBefore = async (session) => {
  const result = await recordGoogleSignIn(db, session.userId);
  if (result !== "ok") {
    console.warn(`[auth] session refused for user ${session.userId}: ${result}`);
    return false;
  }
  return undefined;
};
