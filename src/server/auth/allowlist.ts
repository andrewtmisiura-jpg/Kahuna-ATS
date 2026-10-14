import type { BetterAuthOptions } from "better-auth";

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;
type SessionCreateBefore = NonNullable<
  NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["create"]>["before"]
>;

export const SIGN_IN_REFUSED = "Ask an admin to add you";

// The allowlist is the app_user table: rows an Admin created in Settings > Users.
// Better Auth calls this before create-user, link-account and every Google sign-in.
// Returning nothing admits the identity; returning { error } refuses it.
export const validateAllowlistedUser: ValidateUserInfo = async ({ user, source }) => {
  const email = user.email?.trim().toLowerCase();
  if (!email) {
    return { error: "email_required", errorDescription: SIGN_IN_REFUSED };
  }

  // Sign-in never creates a user. An email with no app_user row is refused and no row is written.
  if (source.action === "create-user") {
    return { error: "not_allowlisted", errorDescription: SIGN_IN_REFUSED };
  }

  // TODO(stage 2): with the app_user table in place,
  // - refuse unless an app_user row with this email exists and status is active,
  // - refuse unless Google reported email_verified,
  // - bind google_sub on first sign-in and refuse a later sign-in with a different sub,
  // - stamp last_sign_in_at.
  return undefined;
};

// Runs before a database session row is written. Stage 2 refuses disabled users here
// as well, so a disabled account can never obtain a fresh session.
export const refuseDisabledUserSession: SessionCreateBefore = async () => {
  // TODO(stage 2): load app_user by session.userId and return false when status is disabled.
  return undefined;
};
