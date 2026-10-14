import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { appUser, authAccount, authSession } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

// Staff accounts: the app_user table is both Better Auth's user model and the
// sign-in allowlist (DATA_MODEL.md, app_user). Rows are created here, by the seed
// or an Admin; Google sign-in never creates one.

export type AppUser = typeof appUser.$inferSelect;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Db, email: string): Promise<AppUser | null> {
  const rows = await db.select().from(appUser).where(eq(appUser.email, normalizeEmail(email))).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<AppUser | null> {
  const rows = await db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  return rows[0] ?? null;
}

// Disabling a user or changing their role must end their sessions at once.
export async function deleteUserSessions(db: Db, userId: string) {
  await db.delete(authSession).where(eq(authSession.userId, userId));
}

// Creates the Admin row if the email is new. With `promote`, an existing row is
// re-enabled and made an Admin too (the user:add-admin command, so the owner can
// never be locked out). The seed does not promote, so re-running it changes nothing.
export async function ensureAdminUser(
  db: Db,
  email: string,
  options: { promote?: boolean } = {},
): Promise<{ user: AppUser; created: boolean }> {
  const existing = await findUserByEmail(db, email);
  if (existing) {
    const needsChange = existing.role !== "admin" || existing.status !== "active";
    if (!options.promote || !needsChange) return { user: existing, created: false };
    const [updated] = await db
      .update(appUser)
      .set({ role: "admin", status: "active" })
      .where(eq(appUser.id, existing.id))
      .returning();
    await deleteUserSessions(db, existing.id);
    return { user: updated!, created: false };
  }
  const [user] = await db
    .insert(appUser)
    .values({ id: uuidv7(), email: normalizeEmail(email), role: "admin", status: "active" })
    .returning();
  return { user: user!, created: true };
}

export type GoogleSignInCheck = "ok" | "not_allowlisted" | "disabled" | "email_not_verified" | "google_sub_mismatch";

// The allowlist rule, read-only: called by Better Auth before it links a Google
// account or signs an existing user in.
export async function checkGoogleSignIn(
  db: Db,
  input: { email: string; emailVerified: boolean; googleSub: string | undefined },
): Promise<GoogleSignInCheck> {
  const user = await findUserByEmail(db, input.email);
  if (!user) return "not_allowlisted";
  if (user.status !== "active") return "disabled";
  if (!input.emailVerified) return "email_not_verified";
  if (user.googleSub && input.googleSub && user.googleSub !== input.googleSub) return "google_sub_mismatch";
  return "ok";
}

export type SignInRecord = "ok" | "missing" | "disabled" | "google_sub_mismatch";

// Runs when Better Auth is about to create a session, which is every successful
// sign-in. Binds the Google account id on the first one, refuses a different id
// later, and stamps last_sign_in_at.
export async function recordGoogleSignIn(db: Db, userId: string): Promise<SignInRecord> {
  const user = await findUserById(db, userId);
  if (!user) return "missing";
  if (user.status !== "active") return "disabled";

  const accounts = await db
    .select({ accountId: authAccount.accountId })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, "google")))
    .limit(1);
  const googleSub = accounts[0]?.accountId ?? null;
  if (user.googleSub && googleSub && user.googleSub !== googleSub) return "google_sub_mismatch";

  await db
    .update(appUser)
    .set({ googleSub: user.googleSub ?? googleSub, lastSignInAt: new Date() })
    .where(eq(appUser.id, userId));
  return "ok";
}
