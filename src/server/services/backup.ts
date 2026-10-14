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
import type { Providers } from "./messaging/providers/types";
import { notifyAdmin } from "./notify";
import { centralDate, centralInstant, centralParts } from "./time";

// The nightly backup (PLAN.md, Stack; DATA_MODEL.md, "Retention policy
// defaults"): pg_dump in custom format, uploaded to a private Cloudflare R2
// bucket through the S3 API at tidepool/<date>.dump, with a 35-day lifecycle
// rule on the bucket. Skipped with a warning while the R2 variables are unset.
// The last success is the cron_heartbeat row named "backup"; the digest reports
// its age and alerts past 36 hours. scripts/restore.sh restores a dump.
//
// pg_dump refuses to dump a server newer than itself, and Railway's Postgres is
// version 18, so the cron service runs from Dockerfile.cron with
// postgresql-client-18. Before each dump the service compares `pg_dump --version`
// with the server's major version and refuses, with its own alert, when pg_dump
// is older, so the failure says what to fix instead of surfacing as a pg_dump error.

const execFileAsync = promisify(execFile);

export const BACKUP_HOUR_CENTRAL = 3;
export const BACKUP_KEY_PREFIX = "tidepool/";
// A failed attempt may be retried after this long; a success waits for the next night.
export const BACKUP_RETRY_AFTER_MS = 60 * 60_000;
const BACKUP_ATTEMPT_NAME = "backup_attempt";

// The variables read: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET and PG_BIN (the directory holding pg_dump;
// locally /usr/lib/postgresql/16/bin; unset in the Dockerfile.cron image, where
// postgresql-client-18 puts pg_dump on PATH).
export type BackupEnv = Record<string, string | undefined>;

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

export function r2Config(env: BackupEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET };
}

// pg_dump inside PG_BIN when it is set, else plain pg_dump from PATH.
export function pgDumpPath(env: BackupEnv = process.env): string {
  return env.PG_BIN ? join(env.PG_BIN, "pg_dump") : "pg_dump";
}

// The major version in `pg_dump --version` output, e.g. 16 from
// "pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)" or 18 from "pg_dump (PostgreSQL) 18beta1".
export function parsePgDumpMajor(output: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(output) ?? /\bpg_dump\b\D*(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

export async function pgDumpMajorVersion(env: BackupEnv = process.env): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(pgDumpPath(env), ["--version"]));
  } catch (error) {
    const detail = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error);
    throw new Error(`pg_dump --version failed (${pgDumpPath(env)}): ${detail.slice(0, 300)}`);
  }
  const major = parsePgDumpMajor(stdout);
  if (major === null) throw new Error(`Could not read the pg_dump version from: ${stdout.trim().slice(0, 200)}`);
  return major;
}

// The database server's major version: 160004 is 16, 180000 is 18.
export async function serverMajorVersion(db: Db): Promise<number> {
  const rows = await db.execute<{ version: string }>(sql`select current_setting('server_version_num') as version`);
  const num = Number(rows[0]?.version);
  if (!Number.isFinite(num) || num <= 0) throw new Error("Could not read the database server version");
  return Math.floor(num / 10_000);
}

export type PgDumpVersionCheck = { ok: boolean; pgDumpMajor: number; serverMajor: number };

// pg_dump must be at least the server's major version (it refuses a newer server).
export async function checkPgDumpVersion(db: Db, env: BackupEnv = process.env): Promise<PgDumpVersionCheck> {
  const [pgDumpMajor, serverMajor] = await Promise.all([pgDumpMajorVersion(env), serverMajorVersion(db)]);
  return { ok: pgDumpMajor >= serverMajor, pgDumpMajor, serverMajor };
}

export const PG_DUMP_TOO_OLD_ALERT = "backup_pg_dump_too_old";

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
  | { kind: "skipped"; reason: "r2_not_configured" | "not_due" | "no_database_url" }
  | { kind: "refused"; reason: "pg_dump_too_old"; pgDumpMajor: number; serverMajor: number };

export type BackupOptions = { now?: Date; env?: BackupEnv; upload?: Uploader; providers?: Providers };

// Dumps and uploads now, then records the success. Throws when either step fails.
// Refuses, with an alert, when pg_dump is older than the database server.
export async function runBackup(db: Db, options: BackupOptions = {}): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const config = r2Config(env);
  const upload = options.upload ?? (config ? createR2Uploader(config) : null);
  if (!upload) {
    console.warn("[backup] R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are not all set; backup skipped");
    return { kind: "skipped", reason: "r2_not_configured" };
  }
  if (!env.DATABASE_URL) return { kind: "skipped", reason: "no_database_url" };

  const versions = await checkPgDumpVersion(db, env);
  if (!versions.ok) {
    const subject = `Backup refused: pg_dump ${versions.pgDumpMajor} is older than the database (PostgreSQL ${versions.serverMajor})`;
    const body = [
      `pg_dump ${versions.pgDumpMajor} cannot back up a PostgreSQL ${versions.serverMajor} database, so tonight's backup did not run.`,
      `Fix: build the cron service from Dockerfile.cron, which installs postgresql-client-${versions.serverMajor} (edit the package name there if the`,
      `database moved to a newer version), or set PG_BIN to a directory holding pg_dump ${versions.serverMajor} or newer.`,
      "Railway's own scheduled Postgres backups are unaffected.",
    ].join("\n");
    console.error(`[backup] ${subject}`);
    await notifyAdmin(db, PG_DUMP_TOO_OLD_ALERT, subject, body, { providers: options.providers, now });
    return { kind: "refused", reason: "pg_dump_too_old", pgDumpMajor: versions.pgDumpMajor, serverMajor: versions.serverMajor };
  }

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

export async function runNightlyBackupIfDue(db: Db, options: BackupOptions = {}): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  if (!options.upload && !r2Config(env)) {
    if (centralParts(now).hour === BACKUP_HOUR_CENTRAL) console.warn("[backup] R2 variables not set; the nightly backup is skipped");
    return { kind: "skipped", reason: "r2_not_configured" };
  }
  if (!(await claimNightlyBackup(db, now))) return { kind: "skipped", reason: "not_due" };
  return runBackup(db, { now, env, upload: options.upload, providers: options.providers });
}
