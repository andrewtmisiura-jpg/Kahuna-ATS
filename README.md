# Tidepool

Kahuna Window Cleaning's hiring system: applicant pages, staff review, texts and email, reports. The product spec is [docs/PLAN.md](docs/PLAN.md) and the schema spec is [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Local setup

1. Install Node 22 and pnpm 10, plus Postgres 16 server binaries (`initdb`, `pg_ctl` under `/usr/lib/postgresql/16/bin`, or set `PG_BIN`).
2. `pnpm install`
3. `pnpm db:local:init` creates a cluster in `.pgdata` on port 54329 with the `tidepool` and `tidepool_test` databases (later: `pnpm db:local:start` and `pnpm db:local:stop`).
4. `cp .env.example .env`, set `DEV_AUTH_EMAIL` to your email (outside production that signs you in as an Admin without Google) and `ADMIN_EMAIL` to the first Admin's Google email.
5. `pnpm db:migrate` applies the committed SQL migrations in `drizzle/`.
6. `pnpm db:seed` loads the one-time Phase 1 seed (employer, first Admin, roles, pipelines, picklists, legal text v1, templates, snow form v1 published, window form v1 draft, both openings, the two launch entry codes). Re-running is a no-op; it warns about any `DRAFT` placeholder still in `src/db/seed/owner-input.ts`.
7. `pnpm dev` and open http://localhost:3000/admin (applicant pages are at `/`).
8. `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest against `DATABASE_URL_TEST`, reset on every run) and `pnpm build` are what CI runs.
9. `pnpm test:e2e` runs Playwright on one phone viewport against the dev server.
10. Schema changes: edit `src/db/schema`, run `pnpm db:generate`, review the SQL in `drizzle/`, commit it. Hand-written SQL (triggers, anything drizzle cannot express) goes in a custom migration: `pnpm exec drizzle-kit generate --custom --name <what>`.
11. `pnpm user:add-admin <email>` creates or re-enables an Admin so the owner is never locked out. `pnpm cron` is the 5-minute job Railway runs as a separate service.
12. `scripts/readonly-role.sql` creates the `tidepool_readonly` database user for the owner's own queries; run it once by hand as the app's database user (see the comment in the file).

## Layout

- `src/app/(public)` applicant pages, phone-first; `src/app/(admin)` staff pages behind sign-in; `src/app/(auth)` the sign-in page.
- `src/server/services` holds all business logic as plain functions that take a `Db` handle; route handlers and server actions only call them.
- `src/server/auth` is Better Auth (Google sign-in, allowlist, database sessions) and `requireRole`.
- `src/db` is Drizzle: `schema/` one file per area of DATA_MODEL.md, `migrate.ts`, `seed/` (`index.ts` is the seed, `run.ts` the `pnpm db:seed` command); migrations live in `drizzle/` (`0000` generated, `0001` the hand-written triggers and the nulls-not-distinct partial unique).
- Database rules: every primary key is an app-generated UUIDv7 (`src/lib/uuid.ts`); `application_event`, `consent_event` and `audit_log` reject UPDATE and DELETE (SQLSTATE `TP001`); published question, form and legal text versions reject edits (SQLSTATE `TP002`); the Phase 3 purge is the one exemption, through `set local tidepool.purge = 'on'`.
- `src/cron/index.ts` is the cron entry point. `railway.json` configures the web service (build, pre-deploy migrate, `/health` check); point the cron service at `railway.cron.json` in its Railway settings so it runs `pnpm cron` every 5 minutes without a healthcheck.

Next.js ships its own current documentation in `node_modules/next/dist/docs`; read it before writing App Router code, since conventions moved in version 16 (for example `proxy.ts` replaces `middleware.ts`).

Set `TZ=UTC` wherever the app runs; every timestamp is stored in UTC and reported in Central time through one helper.
