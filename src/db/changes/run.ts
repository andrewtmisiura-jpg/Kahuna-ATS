import { env, loadDotEnv } from "@/config/env";

// `pnpm db:changes`: applies the one-time content changes listed in ./index.ts
// that are not yet in applied_change. Runs on every deploy after migrate and seed
// (pnpm db:migrate && pnpm db:seed && pnpm db:changes); a second run does nothing.
// Exits non-zero when a change fails, which stops the deploy.

async function main() {
  loadDotEnv();
  env();

  // Imported after loadDotEnv so the pool reads DATABASE_URL from .env.
  const { db, sql } = await import("@/db");
  const { CHANGES, runChanges } = await import("@/db/changes");
  try {
    const report = await runChanges(db, CHANGES, (line) => console.log(`[db:changes] ${line}`));
    if (report.applied.length === 0) {
      console.log(`[db:changes] nothing to do: all ${report.skipped.length} changes already applied`);
    } else {
      console.log(`[db:changes] applied ${report.applied.length} change(s), ${report.skipped.length} already applied`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[db:changes] failed:", error instanceof Error ? error.message : error);
  if (error instanceof Error && error.cause) console.error(error.cause);
  process.exit(1);
});
