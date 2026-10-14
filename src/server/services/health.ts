import { sql } from "drizzle-orm";
import type { Db } from "@/db";

export type HealthReport = {
  ok: boolean;
  database: "ok" | "error";
  checkedAt: string;
};

// /health is 200 only when the database answers. Still to do with the cron service:
// the report must also fail when the newest cron_heartbeat row is older than 15 minutes.
export async function checkHealth(db: Db): Promise<HealthReport> {
  let database: HealthReport["database"] = "error";
  try {
    await db.execute(sql`select 1`);
    database = "ok";
  } catch (error) {
    console.error("[health] database check failed", error);
  }
  return { ok: database === "ok", database, checkedAt: new Date().toISOString() };
}
