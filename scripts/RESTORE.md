# Backups and the restore test

The cron service runs `pg_dump` in custom format every night at 3am Central and uploads it to the private Cloudflare R2 bucket as `tidepool/<date>.dump` (date in Central time). R2 encrypts at rest and a 35-day lifecycle rule on the bucket deletes old dumps, so a strip or deletion is complete everywhere within 35 days. Railway's own scheduled Postgres backups stay on as a second copy.

The code is `src/server/services/backup.ts`; the cron step is `runNightlyBackupIfDue` in `src/cron/pass.ts`. The last success is the `cron_heartbeat` row named `backup`; the daily digest prints its age and `notifyAdmin` fires `backup_stale` when it passes 36 hours.

## pg_dump must match the database (version 18)

Production Postgres on Railway is version 18, and `pg_dump` refuses to dump a server newer than itself. The cron service is therefore built from `Dockerfile.cron` (`railway.cron.json` sets the builder to `DOCKERFILE` and the path to `Dockerfile.cron`): Node 22 on Debian bookworm, plus `postgresql-client-18` from the PostgreSQL apt repository (`apt.postgresql.org`, `bookworm-pgdg`), which puts `pg_dump` 18 on `PATH`. The image build fails if `pg_dump --version` is not 18.

Before every dump the backup compares `pg_dump --version` with the server's major version (`server_version_num`). When `pg_dump` is older it does not try: it logs and emails the alert "Backup refused: pg_dump N is older than the database (PostgreSQL M)" (kind `backup_pg_dump_too_old`, at most once an hour), records no success, and marks the cron pass failed. The fix is to deploy the cron service from `Dockerfile.cron`, or set `PG_BIN` to a directory holding a new enough `pg_dump`. If Railway moves the database to a newer major version, change `postgresql-client-18` in `Dockerfile.cron` to match.

## Variables

On the cron service in Railway (the web service does not need them):

| Variable | Meaning |
|---|---|
| `R2_ACCOUNT_ID` | The Cloudflare account id (the first part of the R2 S3 endpoint) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 API token scoped to the one bucket, object read and write only |
| `R2_BUCKET` | The bucket name |
| `PG_BIN` | The directory holding `pg_dump`, only when the right one is not on `PATH`. The backup uses `$PG_BIN/pg_dump` when it is set and plain `pg_dump` otherwise. Leave it unset on Railway: the `Dockerfile.cron` image has `pg_dump` 18 on `PATH`. Locally `/usr/lib/postgresql/16/bin` for the version 16 cluster |

While any R2 variable is unset the backup step logs a warning and does nothing, so a fresh deploy never fails on it.

Bucket setup, once: create the bucket in Cloudflare R2, add a lifecycle rule that deletes objects under `tidepool/` after 35 days, create an API token for that bucket with object read and write, and paste the four values into the cron service's variables. The first dump appears the next morning; `pnpm cron` run by hand after 3am Central also runs it.

## Restoring a dump

`scripts/restore.sh <dump> <DATABASE_URL>` restores into an existing database, dropping objects first (`--clean --if-exists`). The script refuses a database whose name does not contain `scratch`, `restore` or `test` unless `RESTORE_ALLOW_ANY_DB=1` is set, so a slip can never hit production. The first argument is a local file, or an R2 key such as `tidepool/2026-10-19.dump`, which the script downloads with the `aws` CLI (the four R2 variables must be set); without the CLI, download the object from the Cloudflare dashboard and pass the file.

Set `PG_BIN` when `pg_restore` is not on `PATH`. A production dump is written by `pg_dump` 18, so it needs `pg_restore` 18 (an older `pg_restore` stops with "unsupported version in file header") and a Postgres 18 database to restore into. On a workstation, install `postgresql-client-18` (Debian or Ubuntu: from `apt.postgresql.org`, as in `Dockerfile.cron`; macOS: `brew install postgresql@18`):

```sh
PG_BIN=/usr/lib/postgresql/18/bin scripts/restore.sh tidepool/2026-10-19.dump <DATABASE_URL of a Postgres 18 scratch database>
```

The local version 16 cluster on port 54329 is fine for dumps of the local database (`PG_BIN=/usr/lib/postgresql/16/bin`), not for production dumps.

## The restore test the plan requires (before go-live, Mon Oct 19)

PLAN.md ("Before you say live", item 11) asks the builder to show last night's dump restored into a scratch database with the list view open. Steps:

1. Create a scratch Postgres 18 in the Railway project: a second Postgres service named `tidepool-scratch` (Railway's Postgres is version 18, the same as production). Copy its public `DATABASE_URL`; the database name must contain `scratch`, `restore` or `test` for the script to accept it, so create one with `createdb tidepool_scratch` against that server, or set `RESTORE_ALLOW_ANY_DB=1` for this one restore into the brand-new service.
2. Restore the newest dump into it from a workstation with `pg_restore` 18: `PG_BIN=/usr/lib/postgresql/18/bin scripts/restore.sh tidepool/<yesterday>.dump <scratch DATABASE_URL>`. The script prints row counts for `application`, `person`, `message` and `application_event` at the end; compare them with production (`select count(*)` on the same tables through the read-only user).
3. Point a copy of the app at it and open the list view: locally, `DATABASE_URL=<scratch URL> CRON_HEARTBEAT_OPTIONAL=true pnpm dev --port 3105`, sign in with the development bypass, open the list at `/admin` and one profile, and confirm the applications, stage history and messages match production for two or three people.
4. Confirm the append-only triggers survived the restore: `update application_event set note = 'x' where false` must succeed, and `update application_event set note = 'x'` on one real row must fail with SQLSTATE `TP001`.
5. Delete the scratch database (Railway: delete the service; locally: `dropdb tidepool_scratch`). Record the date and the row counts in the go-live checklist.

Repeat the test whenever the schema gains a table the dump might not cover (every table is in `public`, so a plain `pg_dump` covers it) and once a quarter afterward.

## Local check of the dump itself

`pnpm test` runs `tests/messaging-backup.test.ts`, which runs `pg_dump` against the test database into a temp file and feeds it to a fake uploader, so a missing binary or a broken flag shows up in CI, not at 3am. The same file checks the version guard with a stand-in `pg_dump` that reports an old version: the backup is refused, nothing is uploaded or recorded, and the alert is queued.

`Dockerfile.cron` itself is not built in CI. After changing it, build it once (`docker build -f Dockerfile.cron -t tidepool-cron .`) and run `docker run --rm tidepool-cron pg_dump --version`, or watch the cron service's first deploy log on Railway.
