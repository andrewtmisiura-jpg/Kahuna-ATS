import {
  boolean,
  index,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { userRoleEnum, userStatusEnum } from "./enums";

// app_user is Better Auth's user model and the sign-in allowlist: rows an Admin
// creates in Settings > Users, keyed by lowercase email. Better Auth's base
// columns (name, email, email_verified, image, created_at, updated_at) sit beside
// the DATA_MODEL.md columns. src/server/auth/auth.ts maps the model names
// app_user, auth_session, auth_account and auth_verification to these tables.
export const appUser = pgTable(
  "app_user",
  {
    id: id(),
    email: text().notNull().unique(),
    name: text(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    status: userStatusEnum().notNull().default("active"),
    role: userRoleEnum().notNull(),
    // Google account id, bound on first sign-in. Null means added but not yet signed in.
    googleSub: text(),
    invitedBy: uuid().references((): AnyPgColumn => appUser.id),
    lastSignInAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("app_user_google_sub_unique").on(table.googleSub)],
);

// The three tables below are Better Auth's own. Sessions last 7 days and never
// roll forward; disabling a user deletes their session rows (users service).
export const authSession = pgTable(
  "auth_session",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    token: text().notNull().unique(),
    expiresAt: timestamptz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_session_user_id_idx").on(table.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_account_user_id_idx").on(table.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);
