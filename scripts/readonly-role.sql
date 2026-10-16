-- Read-only database role for the owner's own queries (PLAN.md, Stack).
-- Not a migration: run it once, by hand, as the application's database user
-- (Railway's default user), which owns every table and runs the migrations:
--
--   psql "$DATABASE_URL" -v password='<a long random password>' -f scripts/readonly-role.sql
--
-- Re-running is safe: the role is created only if missing and grants are idempotent.
\set ON_ERROR_STOP on

select format('create role tidepool_readonly login password %L', :'password')
where not exists (select 1 from pg_roles where rolname = 'tidepool_readonly')
\gexec

select format('grant connect on database %I to tidepool_readonly', current_database())
\gexec

grant usage on schema public to tidepool_readonly;
grant select on all tables in schema public to tidepool_readonly;
grant select on all sequences in schema public to tidepool_readonly;

-- Tables created by later migrations (run by the current user) are readable too.
alter default privileges in schema public grant select on tables to tidepool_readonly;
alter default privileges in schema public grant select on sequences to tidepool_readonly;

-- Except integration_secret, which holds the Quo webhook signing secret and is for the
-- server alone (DATA_MODEL.md). The grants above include it, so take it back on every run;
-- migration 0006 does the same when this role already exists before the table.
select 'revoke all on table public.integration_secret from tidepool_readonly'
where to_regclass('public.integration_secret') is not null
\gexec

-- Belt and braces: every session on this role is read-only and short.
alter role tidepool_readonly set default_transaction_read_only = on;
alter role tidepool_readonly set statement_timeout = '60s';
alter role tidepool_readonly set idle_in_transaction_session_timeout = '60s';
