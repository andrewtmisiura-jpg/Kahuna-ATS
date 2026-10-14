# Tidepool

Kahuna Window Cleaning's hiring system: applicant pages, staff review, texts and email, reports. The product spec is [docs/PLAN.md](docs/PLAN.md) and the schema spec is [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Local setup

1. Install Node 22 and pnpm 10, plus Postgres 16 server binaries (`initdb`, `pg_ctl` under `/usr/lib/postgresql/16/bin`, or set `PG_BIN`).
2. `pnpm install`
3. `pnpm db:local:init` creates a cluster in `.pgdata` on port 54329 with the `tidepool` and `tidepool_test` databases (later: `pnpm db:local:start` and `pnpm db:local:stop`).
4. `cp .env.example .env` and set `DEV_AUTH_EMAIL` to your email: outside production that signs you in as an Admin without Google.
5. `pnpm db:migrate` applies the committed SQL migrations in `drizzle/`.
6. `pnpm dev` and open http://localhost:3000/admin (applicant pages are at `/`).
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest against `DATABASE_URL_TEST`, reset on every run) and `pnpm build` are what CI runs.
8. `pnpm test:e2e` runs Playwright on one phone viewport against the dev server.
9. Schema changes: edit `src/db/schema`, run `pnpm db:generate`, review the SQL in `drizzle/`, commit it.
10. `pnpm db:seed` loads the one-time Phase 1 seed; `pnpm cron` is the 5-minute job Railway runs as a separate service.

## Layout

- `src/app/(public)` applicant pages, phone-first; `src/app/(admin)` staff pages behind sign-in; `src/app/(auth)` the sign-in page.
- `src/server/services` holds all business logic as plain functions that take a `Db` handle; route handlers and server actions only call them.
- `src/server/auth` is Better Auth (Google sign-in, allowlist, database sessions) and `requireRole`.
- `src/db` is Drizzle: `schema/` per area, `migrate.ts`, `seed.ts`; migrations live in `drizzle/`.
- `src/cron/index.ts` is the cron entry point. `railway.json` configures the web service (build, pre-deploy migrate, `/health` check); point the cron service at `railway.cron.json` in its Railway settings so it runs `pnpm cron` every 5 minutes without a healthcheck.

Next.js ships its own current documentation in `node_modules/next/dist/docs`; read it before writing App Router code, since conventions moved in version 16 (for example `proxy.ts` replaces `middleware.ts`).

Set `TZ=UTC` wherever the app runs; every timestamp is stored in UTC and reported in Central time through one helper.
