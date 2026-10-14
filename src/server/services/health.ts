import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { cronHeartbeat } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

// /health and the cron heartbeat (PLAN.md, Stack). The cron service writes one
// cron_heartbeat row per job name; /health is 200 only when the database answers
// and the "cron" beat is under 15 minutes old. CRON_HEARTBEAT_OPTIONAL=true
// relaxes the heartbeat for the first deploy, before the cron service exists.

export const CRON_HEARTBEAT_NAME = "cron";
export const BACKUP_HEARTBEAT_NAME = "backup";
export const HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

export type HealthReport = {
  ok: boolean;
  database: "ok" | "error";
  cron: {
    status: "ok" | "stale" | "missing" | "optional";
    beatAt: string | null;
    ageSeconds: number | null;
  };
  checkedAt: string;
};

export async function checkHealth(db: Db, options: { now?: Date; heartbeatOptional?: boolean } = {}): Promise<HealthReport> {
  const now = options.now ?? new Date();
  let database: HealthReport["database"] = "error";
  let beatAt: Date | null = null;
  try {
    await db.execute(sql`select 1`);
    database = "ok";
    beatAt = await readHeartbeat(db, CRON_HEARTBEAT_NAME);
  } catch (error) {
    console.error("[health] database check failed", error);
  }

  const ageSeconds = beatAt ? Math.max(0, Math.round((now.getTime() - beatAt.getTime()) / 1000)) : null;
  const fresh = beatAt !== null && now.getTime() - beatAt.getTime() <= HEARTBEAT_MAX_AGE_MS;
  const cron: HealthReport["cron"] = {
    status: options.heartbeatOptional ? "optional" : beatAt === null ? "missing" : fresh ? "ok" : "stale",
    beatAt: beatAt?.toISOString() ?? null,
    ageSeconds,
  };
  const ok = database === "ok" && (options.heartbeatOptional === true || fresh);
  return { ok, database, cron, checkedAt: now.toISOString() };
}

export function heartbeatOptionalFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.CRON_HEARTBEAT_OPTIONAL === "true";
}

export async function readHeartbeat(db: Db, name: string): Promise<Date | null> {
  const [row] = await db.select({ beatAt: cronHeartbeat.beatAt }).from(cronHeartbeat).where(eq(cronHeartbeat.name, name)).limit(1);
  return row?.beatAt ?? null;
}

// Upserts the row; a beat never moves backwards, so overlapping runs are safe.
export async function writeHeartbeat(db: Db, name: string, at: Date = new Date()): Promise<void> {
  await db
    .insert(cronHeartbeat)
    .values({ id: uuidv7(), name, beatAt: at })
    .onConflictDoUpdate({
      target: cronHeartbeat.name,
      set: { beatAt: sql`greatest(${cronHeartbeat.beatAt}, excluded.beat_at)` },
    });
}
