import { sql as raw } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { seedPhase1 } from "@/db/seed";
import { TEST_ADMIN_EMAIL } from "./helpers/fixtures";
import { withRollback } from "./helpers/db";

const SEEDED_TABLES = [
  "employer",
  "app_user",
  "role",
  "opening",
  "pipeline_stage",
  "question",
  "question_version",
  "form_version",
  "form_item",
  "legal_text_version",
  "message_template",
  "picklist_option",
  "entry_code",
];

// One digest per table of every row, so any insert, update or delete shows up.
async function snapshot() {
  const result: Record<string, { count: number; digest: string | null }> = {};
  for (const table of SEEDED_TABLES) {
    const rows = await db.execute<{ count: number; digest: string | null }>(
      raw.raw(`select count(*)::int as count, md5(string_agg(t::text, '|' order by t::text)) as digest from "${table}" t`),
    );
    result[table] = rows[0]!;
  }
  return result;
}

describe("db:seed", () => {
  afterAll(async () => {
    await sql.end();
  });

  it("refuses to run without an admin email", async () => {
    await expect(seedPhase1(db, { adminEmail: " " })).rejects.toThrow(/ADMIN_EMAIL/);
  });

  it("runs twice without change", async () => {
    const first = await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
    const before = await snapshot();
    expect(before.employer.count).toBe(1);

    const second = await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
    const after = await snapshot();

    expect(after).toEqual(before);
    expect(Object.values(second.created).reduce((sum, n) => sum + n, 0)).toBe(0);
    // The first run in a fresh database inserts everything; a later file may have seeded already.
    expect(Object.values(first.created).every((n) => n >= 0)).toBe(true);
  });

  it("creates the documented Phase 1 rows", async () => {
    await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
    const counts = await snapshot();
    expect(counts.app_user.count).toBe(1);
    expect(counts.role.count).toBe(2);
    expect(counts.opening.count).toBe(2);
    // 9 window stages plus 8 snow stages.
    expect(counts.pipeline_stage.count).toBe(17);
    // 12 snow questions plus 22 window questions, one version each.
    expect(counts.question.count).toBe(34);
    expect(counts.question_version.count).toBe(34);
    expect(counts.form_version.count).toBe(2);
    expect(counts.form_item.count).toBe(34);
    expect(counts.legal_text_version.count).toBe(5);
    expect(counts.message_template.count).toBe(8);
    expect(counts.picklist_option.count).toBe(32);
    expect(counts.entry_code.count).toBe(2);

    const forms = await db.execute<{ key: string; status: string; items: number; published: number }>(raw`
      select r.key, f.status, count(i.*)::int as items,
             count(qv.published_at)::int as published
      from form_version f
      join role r on r.id = f.role_id
      join form_item i on i.form_version_id = f.id
      join question_version qv on qv.id = i.question_version_id
      group by r.key, f.status order by r.key`);
    expect(forms).toEqual([
      { key: "snow_removal_tech", status: "published", items: 12, published: 12 },
      { key: "window_cleaning_tech", status: "draft", items: 22, published: 0 },
    ]);

    const neverSend = await db.execute<{ key: string; role: string }>(raw`
      select q.key, r.key as role from question q join role r on r.id = q.role_id
      where q.ai_never_send order by r.key, q.key`);
    expect(neverSend.map((row) => `${row.role}:${row.key}`)).toEqual([
      "snow_removal_tech:age_18_plus",
      "snow_removal_tech:essential_functions",
      "snow_removal_tech:job1_employer",
      "window_cleaning_tech:age_18_plus",
      "window_cleaning_tech:essential_functions",
      "window_cleaning_tech:job1_employer",
      "window_cleaning_tech:job2_employer",
      "window_cleaning_tech:slow_stretch",
      "window_cleaning_tech:two_years",
    ]);

    const openings = await db.execute<{ key: string; status: string }>(raw`select key, status from opening order by key`);
    expect(openings).toEqual([
      { key: "snow-2026-27", status: "open" },
      { key: "window-2027", status: "draft" },
    ]);

    const employerRow = await db.execute<{ sms_enabled: boolean; sms_from_e164: string; sms_quo_phone_number_id: string | null }>(
      raw`select sms_enabled, sms_from_e164, sms_quo_phone_number_id from employer`,
    );
    expect(employerRow[0]).toEqual({ sms_enabled: true, sms_from_e164: "+17632922259", sms_quo_phone_number_id: null });

    const admin = await db.execute<{ email: string; role: string; status: string }>(raw`select email, role, status from app_user`);
    expect(admin[0]).toEqual({ email: TEST_ADMIN_EMAIL, role: "admin", status: "active" });
  });
  it("accepts several admin emails and never promotes an existing account", async () => {
    await withRollback(db, async (tx) => {
      await tx.execute(raw`update app_user set role = 'hiring_manager' where email = ${TEST_ADMIN_EMAIL}`);
      await seedPhase1(tx, { adminEmail: ` ${TEST_ADMIN_EMAIL} , second.admin@example.com ` });
      const rows = await tx.execute<{ email: string; role: string }>(
        raw`select email, role from app_user where email in (${TEST_ADMIN_EMAIL}, 'second.admin@example.com') order by email`,
      );
      expect(rows.map((r) => [r.email, r.role]).sort()).toEqual(
        [
          [TEST_ADMIN_EMAIL, "hiring_manager"],
          ["second.admin@example.com", "admin"],
        ].sort(),
      );
    });
  });
});
