import { headers } from "next/headers";
import { env, isProduction } from "@/config/env";
import { getAuth } from "./auth";
import { isUserRole, type UserRole } from "./roles";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  // True only under the development bypass below.
  isDevBypass: boolean;
};

// Development-only sign-in. When DEV_AUTH_EMAIL is set and NODE_ENV is not
// production, every request counts as that email signed in, so the admin screens
// work locally without Google credentials. requireRole maps it to the app_user
// row for that email (creating an Admin row on first use), so the row's status
// and role are what count; the admin role here is only the default for display.
export function devBypassUser(): SessionUser | null {
  if (isProduction()) return null;
  const email = env().DEV_AUTH_EMAIL;
  if (!email) return null;
  return { id: "dev-bypass", email, name: "Development sign-in", role: "admin", isDevBypass: true };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const bypass = devBypassUser();
  if (bypass) return bypass;

  // headers() first: during a build it bails out of prerendering before the
  // auth instance (which inspects the database schema) is ever constructed.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;

  const { user } = session;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: isUserRole(user.role) ? user.role : "viewer",
    isDevBypass: false,
  };
}
