import { sql } from "drizzle-orm";
import type { Db } from "@/db";

export type HealthReport = {
  ok: boolean;
  database: "ok" | "error";
  checkedAt: string;
};

// /health is 200 only when the database answers. Stage 2 adds the cron heartbeat:
// the report must also fail when the newest heartbeat is older than 15 minutes.
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
