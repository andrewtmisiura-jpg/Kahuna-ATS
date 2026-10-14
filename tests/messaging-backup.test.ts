import { existsSync, readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { cronHeartbeat } from "@/db/schema";
import {
  backupKey,
  claimNightlyBackup,
  dumpDatabase,
  lastBackupAt,
  pgDumpPath,
  r2Config,
  runBackup,
  runNightlyBackupIfDue,
  type DumpFile,
} from "@/server/services/backup";
import { BACKUP_HEARTBEAT_NAME } from "@/server/services/health";

// Tuesday Oct 20, 2026: 2:59am, 3:05am and 4:10am CDT.
const BEFORE_3AM = new Date("2026-10-20T07:59:00Z");
const AT_3AM = new Date("2026-10-20T08:05:00Z");
const LATER = new Date("2026-10-20T09:10:00Z");

const env = {
  DATABASE_URL: process.env.DATABASE_URL_TEST,
  PG_BIN: process.env.PG_BIN ?? (existsSync("/usr/lib/postgresql/16/bin/pg_dump") ? "/usr/lib/postgresql/16/bin" : undefined),
};

async function clearBackupRows() {
  await db.delete(cronHeartbeat).where(inArray(cronHeartbeat.name, [BACKUP_HEARTBEAT_NAME, "backup_attempt"]));
}

beforeAll(clearBackupRows);

afterAll(async () => {
  await clearBackupRows();
  await sql.end();
});

describe("backup configuration", () => {
  it("needs all four R2 variables, and skips with a warning otherwise", async () => {
    expect(r2Config({})).toBeNull();
    expect(r2Config({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" })).toBeNull();
    expect(r2Config({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" })).toEqual({
      accountId: "a",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "b",
    });
    expect(await runBackup(db, { now: AT_3AM, env: { DATABASE_URL: env.DATABASE_URL } })).toEqual({ kind: "skipped", reason: "r2_not_configured" });
    expect(await lastBackupAt(db)).toBeNull();
  });

  it("names the object by the Central date and finds pg_dump through PG_BIN", () => {
    expect(backupKey(AT_3AM)).toBe("tidepool/2026-10-20.dump");
    // 11:30pm CDT on Oct 19 is already Oct 20 in UTC; the key follows Central.
    expect(backupKey(new Date("2026-10-20T04:30:00Z"))).toBe("tidepool/2026-10-19.dump");
    expect(pgDumpPath({ PG_BIN: "/usr/lib/postgresql/16/bin" })).toBe("/usr/lib/postgresql/16/bin/pg_dump");
    expect(pgDumpPath({})).toBe("pg_dump");
  });
});

describe("dump and upload", () => {
  it("pg_dump writes a custom-format dump of the test database and cleans up after itself", async () => {
    const file = await dumpDatabase(env.DATABASE_URL!, env);
    try {
      expect(file.bytes).toBeGreaterThan(1000);
      expect(readFileSync(file.path).subarray(0, 5).toString("latin1")).toBe("PGDMP");
    } finally {
      await file.cleanup();
    }
    expect(existsSync(file.path)).toBe(false);
  });

  it("runBackup uploads under tidepool/<date>.dump and records the success", async () => {
    const uploads: { key: string; bytes: number; existedDuringUpload: boolean }[] = [];
    const upload = async (file: DumpFile, key: string) => {
      uploads.push({ key, bytes: file.bytes, existedDuringUpload: existsSync(file.path) });
    };
    const result = await runBackup(db, { now: AT_3AM, env, upload });
    expect(result).toMatchObject({ kind: "done", key: "tidepool/2026-10-20.dump", at: AT_3AM });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ key: "tidepool/2026-10-20.dump", existedDuringUpload: true });
    expect(uploads[0]!.bytes).toBeGreaterThan(1000);
    expect(await lastBackupAt(db)).toEqual(AT_3AM);
  });

  it("a failed upload records nothing and surfaces the error", async () => {
    await clearBackupRows();
    const failing = async () => {
      throw new Error("R2 said no");
    };
    await expect(runBackup(db, { now: AT_3AM, env, upload: failing })).rejects.toThrow("R2 said no");
    expect(await lastBackupAt(db)).toBeNull();
  });

  it("a missing pg_dump binary fails loudly", async () => {
    await expect(dumpDatabase(env.DATABASE_URL!, { PG_BIN: "/nonexistent/bin" })).rejects.toThrow(/pg_dump failed/);
  });
});

describe("the nightly schedule", () => {
  it("claims the night once at or after 3am Central, retries a failure after an hour and rests after a success", async () => {
    await clearBackupRows();
    expect(await claimNightlyBackup(db, BEFORE_3AM)).toBe(false);
    expect(await claimNightlyBackup(db, AT_3AM)).toBe(true);
    // A second pass a minute later (or an overlapping one) does not run again.
    expect(await claimNightlyBackup(db, new Date(AT_3AM.getTime() + 60_000))).toBe(false);
    // Nothing succeeded, so an hour later it may try again.
    expect(await claimNightlyBackup(db, LATER)).toBe(true);

    const uploads: string[] = [];
    const upload = async (_file: DumpFile, key: string) => {
      uploads.push(key);
    };
    await runBackup(db, { now: LATER, env, upload });
    expect(await claimNightlyBackup(db, new Date(LATER.getTime() + 2 * 3_600_000))).toBe(false);
    // The next night is due again.
    expect(await claimNightlyBackup(db, new Date(AT_3AM.getTime() + 86_400_000))).toBe(true);
  });

  it("runNightlyBackupIfDue runs once per night and two concurrent passes upload one dump", async () => {
    await clearBackupRows();
    const uploads: string[] = [];
    const upload = async (_file: DumpFile, key: string) => {
      uploads.push(key);
    };
    expect(await runNightlyBackupIfDue(db, { now: BEFORE_3AM, env, upload })).toEqual({ kind: "skipped", reason: "not_due" });
    const [a, b] = await Promise.all([runNightlyBackupIfDue(db, { now: AT_3AM, env, upload }), runNightlyBackupIfDue(db, { now: AT_3AM, env, upload })]);
    expect([a.kind, b.kind].sort()).toEqual(["done", "skipped"]);
    expect(uploads).toEqual(["tidepool/2026-10-20.dump"]);
    expect(await runNightlyBackupIfDue(db, { now: LATER, env, upload })).toEqual({ kind: "skipped", reason: "not_due" });
    expect(await runNightlyBackupIfDue(db, { now: AT_3AM, env: {} })).toEqual({ kind: "skipped", reason: "r2_not_configured" });
  });
});
