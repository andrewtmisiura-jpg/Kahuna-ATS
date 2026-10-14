#!/usr/bin/env bash
# Restores a Tidepool pg_dump (custom format, made by the nightly backup) into a database.
#
#   scripts/restore.sh <dump file> <DATABASE_URL>
#   scripts/restore.sh tidepool/2026-10-19.dump <DATABASE_URL>   # downloads that key from R2 first (needs the aws CLI)
#
# The target database must already exist and should be a scratch database, never
# production: existing objects are dropped (--clean --if-exists) before the restore.
# PG_BIN points at the Postgres binaries when pg_restore is not on PATH
# (locally /usr/lib/postgresql/16/bin; a production dump comes from pg_dump 18 and needs
# pg_restore 18, for example /usr/lib/postgresql/18/bin).
# See scripts/RESTORE.md for the pre-launch restore test.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <dump file | R2 key tidepool/<date>.dump> <DATABASE_URL>" >&2
  exit 2
fi

SOURCE="$1"
TARGET_URL="$2"
PG_BIN="${PG_BIN:-}"
PG_RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"
PSQL="${PG_BIN:+$PG_BIN/}psql"

if ! command -v "$PG_RESTORE" >/dev/null 2>&1 && [ ! -x "$PG_RESTORE" ]; then
  echo "pg_restore not found (set PG_BIN, for example PG_BIN=/usr/lib/postgresql/16/bin)" >&2
  exit 1
fi

case "$TARGET_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "The second argument must be a postgres:// URL" >&2; exit 2 ;;
esac

# Refuse to restore over a database whose name does not look like a scratch database.
DB_NAME="${TARGET_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
if [ -z "${RESTORE_ALLOW_ANY_DB:-}" ] && ! echo "$DB_NAME" | grep -Eq '(scratch|restore|test)'; then
  echo "Refusing to restore into '$DB_NAME': the database name should contain scratch, restore or test." >&2
  echo "Set RESTORE_ALLOW_ANY_DB=1 if you really mean it." >&2
  exit 1
fi

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

DUMP_FILE="$SOURCE"
if [ ! -f "$SOURCE" ]; then
  case "$SOURCE" in
    tidepool/*.dump)
      : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is needed to download from R2}"
      : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is needed to download from R2}"
      : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is needed to download from R2}"
      : "${R2_BUCKET:?R2_BUCKET is needed to download from R2}"
      if ! command -v aws >/dev/null 2>&1; then
        echo "The aws CLI is needed to download from R2; or download $SOURCE from the Cloudflare dashboard and pass the file." >&2
        exit 1
      fi
      TMP_DIR="$(mktemp -d)"
      DUMP_FILE="$TMP_DIR/$(basename "$SOURCE")"
      echo "Downloading s3://$R2_BUCKET/$SOURCE from R2..."
      AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
        aws s3 cp "s3://$R2_BUCKET/$SOURCE" "$DUMP_FILE" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
      ;;
    *)
      echo "No such file: $SOURCE" >&2
      exit 1
      ;;
  esac
fi

echo "Restoring $(basename "$DUMP_FILE") ($(du -h "$DUMP_FILE" | cut -f1)) into $DB_NAME..."
# --no-owner and --no-privileges: the scratch database's user owns everything.
# Exit status 1 from pg_restore means warnings only (for example a missing extension comment); 2 is a hard failure.
set +e
"$PG_RESTORE" --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname "$TARGET_URL" "$DUMP_FILE"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then
  echo "pg_restore exited with $STATUS" >&2
  exit "$STATUS"
fi

echo "Row counts in the restored database:"
"$PSQL" "$TARGET_URL" -Atc "select 'application: ' || count(*) from application union all select 'person: ' || count(*) from person union all select 'message: ' || count(*) from message union all select 'application_event: ' || count(*) from application_event"
echo "Restore finished."
