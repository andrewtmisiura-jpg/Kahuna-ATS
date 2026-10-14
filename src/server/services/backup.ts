import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { cronHeartbeat } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { BACKUP_HEARTBEAT_NAME, readHeartbeat, writeHeartbeat } from "./health";
import { centralDate, centralInstant, centralParts } from "./time";

// The nightly backup (PLAN.md, Stack; DATA_MODEL.md, "Retention policy
// defaults"): pg_dump in custom format, uploaded to a private Cloudflare R2
// bucket through the S3 API at tidepool/<date>.dump, with a 35-day lifecycle
// rule on the bucket. Skipped with a warning while the R2 variables are unset.
// The last success is the cron_heartbeat row named "backup"; the digest reports
// its age and alerts past 36 hours. scripts/restore.sh restores a dump.

const execFileAsync = promisify(execFile);

export const BACKUP_HOUR_CENTRAL = 3;
export const BACKUP_KEY_PREFIX = "tidepool/";
// A failed attempt may be retried after this long; a success waits for the next night.
export const BACKUP_RETRY_AFTER_MS = 60 * 60_000;
const BACKUP_ATTEMPT_NAME = "backup_attempt";

// The variables read: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET and PG_BIN (the directory holding pg_dump;
// locally /usr/lib/postgresql/16/bin, on Railway's image it is on PATH).
export type BackupEnv = Record<string, string | undefined>;

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

export function r2Config(env: BackupEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET };
}

export function pgDumpPath(env: BackupEnv = process.env): string {
  return env.PG_BIN ? join(env.PG_BIN, "pg_dump") : "pg_dump";
}

export function backupKey(now: Date): string {
  return `${BACKUP_KEY_PREFIX}${centralDate(now)}.dump`;
}

export type DumpFile = { path: string; bytes: number; cleanup: () => Promise<void> };

// pg_dump -Fc of the given database into a temp file. The caller deletes it.
export async function dumpDatabase(databaseUrl: string, env: BackupEnv = process.env): Promise<DumpFile> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-backup-"));
  const path = join(dir, "tidepool.dump");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await execFileAsync(pgDumpPath(env), ["--format=custom", "--no-owner", "--no-privileges", "--dbname", databaseUrl, "--file", path], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const { size } = await stat(path);
    return { path, bytes: size, cleanup };
  } catch (error) {
    await cleanup();
    const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : String(error);
    throw new Error(`pg_dump failed: ${detail.slice(0, 500)}`);
  }
}

export type Uploader = (file: DumpFile, key: string) => Promise<void>;

// R2 speaks S3; region is always "auto". Unverified against a live bucket.
export function createR2Uploader(config: R2Config): Uploader {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return async (file, key) => {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(file.path),
        ContentLength: file.bytes,
        ContentType: "application/octet-stream",
      }),
    );
  };
}

export type BackupResult =
  | { kind: "done"; key: string; bytes: number; at: Date }
  | { kind: "skipped"; reason: "r2_not_configured" | "not_due" | "no_database_url" };

// Dumps and uploads now, then records the success. Throws when either step fails.
export async function runBackup(
  db: Db,
  options: { now?: Date; env?: BackupEnv; upload?: Uploader } = {},
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const config = r2Config(env);
  const upload = options.upload ?? (config ? createR2Uploader(config) : null);
  if (!upload) {
    console.warn("[backup] R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are not all set; backup skipped");
    return { kind: "skipped", reason: "r2_not_configured" };
  }
  if (!env.DATABASE_URL) return { kind: "skipped", reason: "no_database_url" };

  const key = backupKey(now);
  const file = await dumpDatabase(env.DATABASE_URL, env);
  try {
    await upload(file, key);
  } finally {
    await file.cleanup();
  }
  await writeHeartbeat(db, BACKUP_HEARTBEAT_NAME, now);
  console.log(`[backup] uploaded ${key} (${file.bytes} bytes)`);
  return { kind: "done", key, bytes: file.bytes, at: now };
}

export function lastBackupAt(db: Db): Promise<Date | null> {
  return readHeartbeat(db, BACKUP_HEARTBEAT_NAME);
}

// True once per night: the pass at or after 3am Central that first claims the
// attempt row. The claim is a conditional upsert, so two overlapping passes
// cannot both run, and a failed attempt may be retried an hour later.
export async function claimNightlyBackup(db: Db, now: Date = new Date()): Promise<boolean> {
  if (centralParts(now).hour < BACKUP_HOUR_CENTRAL) return false;
  const tonight = centralInstant(centralDate(now), BACKUP_HOUR_CENTRAL);
  const last = await lastBackupAt(db);
  if (last && last.getTime() >= tonight.getTime()) return false;

  const retryBefore = new Date(now.getTime() - BACKUP_RETRY_AFTER_MS);
  const claimed = await db
    .insert(cronHeartbeat)
    .values({ id: uuidv7(), name: BACKUP_ATTEMPT_NAME, beatAt: now })
    .onConflictDoUpdate({
      target: cronHeartbeat.name,
      set: { beatAt: sql`excluded.beat_at` },
      setWhere: and(eq(cronHeartbeat.name, BACKUP_ATTEMPT_NAME), lt(cronHeartbeat.beatAt, retryBefore)),
    })
    .returning({ id: cronHeartbeat.id });
  return claimed.length > 0;
}

export async function runNightlyBackupIfDue(
  db: Db,
  options: { now?: Date; env?: BackupEnv; upload?: Uploader } = {},
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  if (!options.upload && !r2Config(env)) {
    if (centralParts(now).hour === BACKUP_HOUR_CENTRAL) console.warn("[backup] R2 variables not set; the nightly backup is skipped");
    return { kind: "skipped", reason: "r2_not_configured" };
  }
  if (!(await claimNightlyBackup(db, now))) return { kind: "skipped", reason: "not_due" };
  return runBackup(db, { now, env, upload: options.upload });
}
