-- Hand-written, additive: integration_secret is readable by the application's own user only
-- (DATA_MODEL.md, integration_secret). scripts/readonly-role.sql runs
-- `alter default privileges ... grant select on tables to tidepool_readonly`, so 0005 gave
-- the read-only user SELECT on the Quo webhook signing secret the moment it created the
-- table. Take that back, and anything PUBLIC holds. The script revokes it again on every
-- run, so the order in which the role and this table appear does not matter.
REVOKE ALL ON TABLE "integration_secret" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tidepool_readonly') THEN
    EXECUTE 'REVOKE ALL ON TABLE "integration_secret" FROM tidepool_readonly';
  END IF;
END
$$;
