import { sql as raw } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";

describe("database", () => {
  afterAll(async () => {
    await sql.end();
  });

  it("answers queries on the migrated test database", async () => {
    const rows = await db.execute<{ one: number }>(raw`select 1 as one`);
    expect(rows[0]?.one).toBe(1);
  });

  it("has the drizzle migrations table from global setup", async () => {
    const rows = await db.execute<{ exists: boolean }>(
      raw`select exists (
        select 1 from information_schema.tables
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
      ) as exists`,
    );
    expect(rows[0]?.exists).toBe(true);
  });
});
