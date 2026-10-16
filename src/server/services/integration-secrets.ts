import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { integrationSecret } from "@/db/schema";

// integration_secret (DATA_MODEL.md): secrets an integration hands Tidepool once,
// stored so nobody copies them by hand. Server-only: nothing here may reach the
// browser, an export, a CSV, an audit payload or a log line. Callers that only
// need to know whether a secret exists use readIntegrationSecretMeta, which
// never selects the value.

export const QUO_WEBHOOK_SECRET_KEY = "quo_webhook_secret";

export type IntegrationSecretMeta = { key: string; createdAt: Date; note: string | null };

export async function readIntegrationSecret(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: integrationSecret.value }).from(integrationSecret).where(eq(integrationSecret.key, key)).limit(1);
  return row?.value ?? null;
}

export async function readIntegrationSecretMeta(db: Db, key: string): Promise<IntegrationSecretMeta | null> {
  const [row] = await db
    .select({ key: integrationSecret.key, createdAt: integrationSecret.createdAt, note: integrationSecret.note })
    .from(integrationSecret)
    .where(eq(integrationSecret.key, key))
    .limit(1);
  return row ?? null;
}

// Inserts the secret unless the key already holds one; true when this call stored it.
// A stored secret is never overwritten: replacing one is a deliberate act (delete
// the row, or set the Railway variable, which wins).
export async function storeIntegrationSecret(db: Db, input: { key: string; value: string; note?: string | null; now?: Date }): Promise<boolean> {
  const inserted = await db
    .insert(integrationSecret)
    .values({ key: input.key, value: input.value, note: input.note ?? null, createdAt: input.now ?? new Date() })
    .onConflictDoNothing({ target: integrationSecret.key })
    .returning({ key: integrationSecret.key });
  return inserted.length > 0;
}

// ---------------------------------------------------------------------------
// The Quo webhook route's secret: QUO_WEBHOOK_SECRET from the environment first
// (a value pasted into Railway always wins), then the stored row. The row is
// cached in memory: a found secret for 5 minutes, a miss for 30 seconds, so a
// burst of deliveries costs at most one query per window.

export const QUO_SECRET_CACHE_MS = 5 * 60_000;
export const QUO_SECRET_MISS_CACHE_MS = 30_000;

export type QuoWebhookSecret = { secret: string; source: "env" | "db" };

let cached: { value: string | null; at: number } | null = null;
let missingLogged = false;

export function quoWebhookSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.QUO_WEBHOOK_SECRET?.trim();
  return value ? value : null;
}

export async function getQuoWebhookSecret(db: Db, options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<QuoWebhookSecret | null> {
  const fromEnv = quoWebhookSecretFromEnv(options.env);
  if (fromEnv) return { secret: fromEnv, source: "env" };
  const now = (options.now ?? new Date()).getTime();
  const ttl = cached?.value ? QUO_SECRET_CACHE_MS : QUO_SECRET_MISS_CACHE_MS;
  if (!cached || now - cached.at >= ttl) {
    cached = { value: await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY), at: now };
  }
  return cached.value ? { secret: cached.value, source: "db" } : null;
}

// True the first time it is called while no secret exists, so the route logs the
// missing secret once instead of on every delivery; a found secret re-arms it.
export function firstMissingQuoSecret(): boolean {
  if (missingLogged) return false;
  missingLogged = true;
  return true;
}

export function noteQuoSecretFound(): void {
  missingLogged = false;
}

// For tests, and for anything that has just stored a new secret in this process.
export function resetQuoWebhookSecretCache(): void {
  cached = null;
  missingLogged = false;
}
