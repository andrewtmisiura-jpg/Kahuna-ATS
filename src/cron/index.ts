import { loadDotEnv } from "@/config/env";

// Entry point for the Railway cron service, run every 5 minutes: `pnpm cron`.
// The pass itself lives in ./pass.ts so tests can run it against a database;
// this file only loads the environment, runs one pass, logs a summary and sets
// the exit code. A failed step is already alerted through notifyAdmin inside
// the pass; exit code 1 makes it visible in Railway's run history as well.

async function main() {
  loadDotEnv();
  const startedAt = new Date();
  console.log(`[cron] pass started ${startedAt.toISOString()}`);
  const { db, sql } = await import("@/db");
  const { getProviders } = await import("@/server/services/messaging/providers");
  const { describePass, runCronPass } = await import("./pass");
  try {
    const report = await runCronPass(db, { now: startedAt, providers: getProviders() });
    console.log(`[cron] ${describePass(report)}`);
    console.log(`[cron] pass finished in ${Date.now() - startedAt.getTime()}ms`);
    if (report.failed.length > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[cron] pass failed", error);
  process.exitCode = 1;
});
