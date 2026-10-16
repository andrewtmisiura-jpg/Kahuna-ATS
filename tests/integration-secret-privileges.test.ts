import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/db";

// integration_secret is for the server alone (DATA_MODEL.md): the read-only
// database user from scripts/readonly-role.sql must not be able to read the Quo
// webhook signing secret, whichever came first, the role or the table. The test
// runs the real script (its psql meta-commands emulated) and the real migration
// 0006 against a scratch role standing in for tidepool_readonly, then drops it.

const ROLE = `tp_readonly_${randomBytes(4).toString("hex")}`;
const PROBE = `tp_privileges_probe_${randomBytes(4).toString("hex")}`;
const ALL_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";

type Step = { sql: string; gexec: boolean };

// Splits a psql script into statements: `\gexec` runs the preceding select and then
// each value it returns, `\set` lines are dropped, comments are skipped.
function psqlSteps(text: string): Step[] {
  const steps: Step[] = [];
  let buffer: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    if (trimmed.startsWith("\\")) {
      if (trimmed === "\\gexec") {
        steps.push({ sql: buffer.join("\n"), gexec: true });
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
    if (trimmed.endsWith(";")) {
      steps.push({ sql: buffer.join("\n"), gexec: false });
      buffer = [];
    }
  }
  expect(buffer.join("").trim(), "the script ends mid-statement").toBe("");
  return steps;
}

async function runReadonlyScript() {
  const text = readFileSync("scripts/readonly-role.sql", "utf8")
    .replaceAll("tidepool_readonly", ROLE)
    .replaceAll(":'password'", `'${randomBytes(12).toString("hex")}'`);
  for (const step of psqlSteps(text)) {
    const rows = await sql.unsafe(step.sql);
    if (!step.gexec) continue;
    for (const row of rows) {
      for (const value of Object.values(row)) await sql.unsafe(String(value));
    }
  }
}

async function runMigration0006() {
  const text = readFileSync("drizzle/0006_integration_secret_private.sql", "utf8").replaceAll("tidepool_readonly", ROLE);
  for (const statement of text.split("--> statement-breakpoint")) await sql.unsafe(statement);
}

async function canTouch(table: string): Promise<boolean> {
  const [row] = await sql<{ can: boolean }[]>`select has_table_privilege(${ROLE}, ${`public.${table}`}, ${ALL_PRIVILEGES}) as can`;
  return row!.can;
}

afterAll(async () => {
  try {
    await sql.unsafe(`drop table if exists public.${PROBE}`);
    const [exists] = await sql`select 1 from pg_roles where rolname = ${ROLE}`;
    if (exists) {
      await sql.unsafe(`drop owned by ${ROLE}`);
      await sql.unsafe(`drop role ${ROLE}`);
    }
  } finally {
    await sql.end();
  }
});

describe("integration_secret privileges", () => {
  it("the read-only user can read every other table but never integration_secret, and re-running the script keeps it so", async () => {
    await runReadonlyScript();
    expect(await canTouch("employer")).toBe(true);
    expect(await canTouch("audit_log")).toBe(true);
    expect(await canTouch("integration_secret")).toBe(false);

    await runReadonlyScript();
    expect(await canTouch("integration_secret")).toBe(false);
    expect(await canTouch("employer")).toBe(true);
  });

  it("migration 0006 takes back the SELECT the script's default privileges give a table created after the role", async () => {
    await runReadonlyScript();
    // What happened to integration_secret in production when 0005 ran after the script:
    // the default privileges hand every new table to the read-only user.
    await sql.unsafe(`create table public.${PROBE} (id int)`);
    expect(await canTouch(PROBE)).toBe(true);
    await sql.unsafe(`drop table public.${PROBE}`);

    await sql.unsafe(`grant select on table public.integration_secret to ${ROLE}`);
    expect(await canTouch("integration_secret")).toBe(true);
    await runMigration0006();
    expect(await canTouch("integration_secret")).toBe(false);
    expect(await canTouch("employer")).toBe(true);
  });

  it("PUBLIC holds nothing on integration_secret", async () => {
    const [row] = await sql<{ acl: string | null }[]>`select relacl::text as acl from pg_class where oid = 'public.integration_secret'::regclass`;
    // An empty ACL means owner-only defaults; otherwise no entry may start with "=" (PUBLIC).
    expect(row!.acl === null || !/(^|[{,])=/.test(row!.acl)).toBe(true);
  });
});
