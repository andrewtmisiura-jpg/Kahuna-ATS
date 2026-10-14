#!/usr/bin/env bash
# Local Postgres 16 cluster for development and tests.
#
#   pnpm db:local:init    create the cluster under .pgdata with the tidepool and tidepool_test databases
#   pnpm db:local:start   start it on port 54329
#   pnpm db:local:stop    stop it
#
# Postgres refuses to run as root, so when this script is run by root it hands
# the cluster to the unprivileged "postgres" user that the server package creates.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA_DIR="$ROOT_DIR/.pgdata"
PORT="${PGPORT_LOCAL:-54329}"
LOG_FILE="$PGDATA_DIR/postgres.log"

if [ ! -x "$PG_BIN/pg_ctl" ]; then
  echo "Postgres 16 binaries not found at $PG_BIN (set PG_BIN to override)" >&2
  exit 1
fi

# Runs a command as the cluster owner. Root cannot own a cluster.
run_pg() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

ensure_owner() {
  mkdir -p "$PGDATA_DIR"
  if [ "$(id -u)" -eq 0 ]; then
    chown postgres:postgres "$PGDATA_DIR"
  fi
}

ensure_databases() {
  for db in tidepool tidepool_test; do
    if ! run_pg "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -Atc "select 1 from pg_database where datname = '$db'" | grep -q 1; then
      run_pg "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$db"
    fi
  done
}

cmd_init() {
  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    ensure_owner
    # trust auth on a loopback-only port is fine for a development cluster
    run_pg "$PG_BIN/initdb" -D "$PGDATA_DIR" --auth=trust --username=postgres --encoding=UTF8 --no-instructions >/dev/null
    cat >>"$PGDATA_DIR/postgresql.conf" <<EOF2

# tidepool local development
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PGDATA_DIR'
timezone = 'UTC'
log_timezone = 'UTC'
EOF2
  fi
  cmd_start
  ensure_databases
  echo "Databases tidepool and tidepool_test are ready on port $PORT"
  echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/tidepool"
  echo "DATABASE_URL_TEST=postgres://postgres@127.0.0.1:$PORT/tidepool_test"
}

cmd_start() {
  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    echo "No cluster at $PGDATA_DIR. Run: pnpm db:local:init" >&2
    exit 1
  fi
  if run_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "Postgres already running on port $PORT"
    return
  fi
  run_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$LOG_FILE" -w start >/dev/null
  echo "Postgres started on port $PORT (log: $LOG_FILE)"
}

cmd_stop() {
  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    echo "No cluster at $PGDATA_DIR"
    return
  fi
  if ! run_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "Postgres is not running"
    return
  fi
  run_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null
  echo "Postgres stopped"
}

case "${1:-}" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  *)
    echo "usage: $0 init|start|stop" >&2
    exit 2
    ;;
esac
