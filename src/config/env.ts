import { z } from "zod";

// Next.js and Railway supply process.env themselves. Scripts run with tsx
// (migrate, seed, cron, drizzle-kit, vitest) call this first to pick up .env.
// Node's loader never overrides a variable that is already set.
export function loadDotEnv() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file, which is normal in CI and production
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().startsWith("postgres", "DATABASE_URL must be a postgres:// URL"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Development-only sign-in bypass. Ignored whenever NODE_ENV is production.
  DEV_AUTH_EMAIL: z.email().optional(),
  // The first Admin account, created by `pnpm db:seed` (which fails without it).
  ADMIN_EMAIL: z.email().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Parsed on first use rather than at import, so `next build` does not need
// every runtime variable and a missing one fails with a readable message.
export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}
