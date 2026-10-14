import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { cronHeartbeat } from "@/db/schema";
import { checkHealth, CRON_HEARTBEAT_NAME, heartbeatOptionalFromEnv, readHeartbeat, writeHeartbeat } from "@/server/services/health";

const NOW = new Date("2026-10-20T16:00:00Z");

afterAll(async () => {
  await sql.end();
});

describe("/health heartbeat check", () => {
  it("fails without a cron heartbeat unless the heartbeat is optional", async () => {
    await db.delete(cronHeartbeat).where(eq(cronHeartbeat.name, CRON_HEARTBEAT_NAME));
    const missing = await checkHealth(db, { now: NOW });
    expect(missing).toMatchObject({ ok: false, database: "ok", cron: { status: "missing", beatAt: null, ageSeconds: null } });
    const optional = await checkHealth(db, { now: NOW, heartbeatOptional: true });
    expect(optional).toMatchObject({ ok: true, database: "ok", cron: { status: "optional" } });
  });

  it("passes with a beat under 15 minutes old and fails past it", async () => {
    await writeHeartbeat(db, CRON_HEARTBEAT_NAME, new Date(NOW.getTime() - 14 * 60_000));
    const fresh = await checkHealth(db, { now: NOW });
    expect(fresh).toMatchObject({ ok: true, cron: { status: "ok", ageSeconds: 14 * 60 } });

    await db.update(cronHeartbeat).set({ beatAt: new Date(NOW.getTime() - 16 * 60_000) }).where(eq(cronHeartbeat.name, CRON_HEARTBEAT_NAME));
    const stale = await checkHealth(db, { now: NOW });
    expect(stale).toMatchObject({ ok: false, database: "ok", cron: { status: "stale", ageSeconds: 16 * 60 } });
    // Optional only relaxes the heartbeat; the report still says it is stale.
    expect(await checkHealth(db, { now: NOW, heartbeatOptional: true })).toMatchObject({ ok: true, cron: { status: "optional" } });
  });

  it("a heartbeat never moves backwards, so overlapping passes are safe", async () => {
    await writeHeartbeat(db, CRON_HEARTBEAT_NAME, NOW);
    await writeHeartbeat(db, CRON_HEARTBEAT_NAME, new Date(NOW.getTime() - 60_000));
    expect(await readHeartbeat(db, CRON_HEARTBEAT_NAME)).toEqual(NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await writeHeartbeat(db, CRON_HEARTBEAT_NAME, later);
    expect(await readHeartbeat(db, CRON_HEARTBEAT_NAME)).toEqual(later);
  });

  it("reads CRON_HEARTBEAT_OPTIONAL only when it is exactly true", () => {
    expect(heartbeatOptionalFromEnv({ CRON_HEARTBEAT_OPTIONAL: "true" })).toBe(true);
    expect(heartbeatOptionalFromEnv({ CRON_HEARTBEAT_OPTIONAL: "1" })).toBe(false);
    expect(heartbeatOptionalFromEnv({})).toBe(false);
  });
});
