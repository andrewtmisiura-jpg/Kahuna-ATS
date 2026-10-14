import { env, loadDotEnv } from "@/config/env";

// `pnpm db:seed`: the one-time Phase 1 seed. Run it once against an empty
// database and locally; re-running is a no-op by key. Fails without ADMIN_EMAIL.
// See ./index.ts and "Seed data for Phase 1" in docs/DATA_MODEL.md.

async function main() {
  loadDotEnv();
  const adminEmail = env().ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error("ADMIN_EMAIL is not set. Add the owner's Google email to .env (or Railway) and run again.");
  }

  // Imported after loadDotEnv so the pool reads DATABASE_URL from .env.
  const { db, sql } = await import("@/db");
  const { seedPhase1 } = await import("@/db/seed");
  try {
    const report = await seedPhase1(db, { adminEmail });
    const total = Object.values(report.created).reduce((sum, n) => sum + n, 0);
    if (total === 0) {
      console.log("[db:seed] nothing to do: every seeded row already exists");
    } else {
      console.log(`[db:seed] inserted ${total} rows:`);
      for (const [table, count] of Object.entries(report.created)) console.log(`  ${table}: ${count}`);
    }
    if (report.drafts.length > 0) {
      console.warn("[db:seed] DRAFT placeholders still in src/db/seed/owner-input.ts (replace before the production seed):");
      for (const path of report.drafts) console.warn(`  ${path}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[db:seed] failed", error);
  process.exit(1);
});
