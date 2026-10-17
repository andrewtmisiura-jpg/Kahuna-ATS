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

export const envSchema = z.object({
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
  // One email, or several separated by commas (see db:seed).
  ADMIN_EMAIL: z
    .string()
    .refine((value) => value.split(",").every((email) => z.email().safeParse(email.trim()).success), {
      message: "Invalid email address in the comma-separated list",
    })
    .optional(),
  // Message providers: "live" uses Quo and Resend, "sink" records sends without
  // sending. Defaults to live in production and sink everywhere else.
  MESSAGE_PROVIDERS: z.enum(["live", "sink"]).optional(),
  QUO_API_KEY: z.string().optional(),
  QUO_API_BASE_URL: z.string().default("https://api.quo.com"),
  RESEND_API_KEY: z.string().optional(),
  // Where notifyAdmin alerts go (the owner's address, not hiring@).
  ALERT_EMAIL: z.email().optional(),
  // AI scoring (Phase 2). Without the key, scoring and the rubric editor's "Try it"
  // say so plainly; the key itself is never logged or returned
  // (src/server/services/scoring/provider.ts).
  ANTHROPIC_API_KEY: z.string().optional(),
  // "live" scores with the Anthropic model, "fake" uses the deterministic stand-in that
  // calls nothing. Defaults to live in production and fake everywhere else.
  SCORING_PROVIDER: z.enum(["live", "fake"]).optional(),
  // The model the live scorer calls. Each score stores the id of the model that answered.
  SCORING_MODEL: z.string().default("claude-opus-5-5"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Parsed on first use rather than at import, so `next build` does not need
// every runtime variable and a missing one fails with a readable message.
export function env(): Env {
  if (!cached) {
    // A blank value (`ALERT_EMAIL=` in .env or an empty Railway variable) means unset.
    const present = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
    const parsed = envSchema.safeParse(present);
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
