import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { env } from "@/config/env";
import { db } from "@/db";
import { appUser, authAccount, authSession, authVerification } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { beforeSessionCreate, validateAllowlistedUser } from "./allowlist";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

// Better Auth addresses tables by model name; these are the DATA_MODEL.md names.
const authSchema = {
  app_user: appUser,
  auth_session: authSession,
  auth_account: authAccount,
  auth_verification: authVerification,
};

export function isGoogleSignInConfigured() {
  const config = env();
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

function createAuth() {
  const config = env();
  const socialProviders = isGoogleSignInConfigured()
    ? {
        google: {
          clientId: config.GOOGLE_CLIENT_ID!,
          clientSecret: config.GOOGLE_CLIENT_SECRET!,
          prompt: "select_account" as const,
        },
      }
    : {};

  return betterAuth({
    appName: "Tidepool",
    baseURL: config.BETTER_AUTH_URL ?? config.PUBLIC_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    socialProviders,
    advanced: {
      // Every table's primary key is an app-generated UUIDv7, the auth tables included.
      database: { generateId: () => uuidv7() },
    },

    user: {
      modelName: "app_user",
      additionalFields: {
        role: { type: "string", required: true, defaultValue: "hiring_manager", input: false },
        status: { type: "string", required: true, defaultValue: "active", input: false },
        googleSub: { type: "string", required: false, input: false },
        invitedBy: { type: "string", required: false, input: false },
        lastSignInAt: { type: "date", required: false, input: false },
      },
      validateUserInfo: validateAllowlistedUser,
    },
    session: {
      modelName: "auth_session",
      // Database sessions that last 7 days and never roll forward; no cookie cache,
      // so disabling a user takes effect on their next request.
      expiresIn: SEVEN_DAYS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "auth_account",
      // An Admin creates the app_user row first (email_verified false); the first Google
      // sign-in links to it. The allowlist hook checks Google's own email_verified claim.
      accountLinking: { enabled: true, trustedProviders: ["google"], requireLocalEmailVerified: false },
    },
    verification: { modelName: "auth_verification" },
    databaseHooks: {
      session: { create: { before: beforeSessionCreate } },
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

// Built on first use rather than at import: Better Auth inspects the Drizzle schema
// when constructed, and the build, the cron and the dev bypass never need it.
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
