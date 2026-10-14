// Entry point for the Railway cron service, run every 5 minutes: `pnpm cron`.
//
// Each pass will: send due messages, queue 24-hour reminders, write a heartbeat,
// run the 3am Central pg_dump to R2 and send the 7am digest. Every step is wrapped
// so one failure never stops the others, and failures go through notifyAdmin.
// Only the heartbeat skeleton exists in stage 1.

async function main() {
  const startedAt = new Date();
  console.log(`[cron] pass started ${startedAt.toISOString()}`);

  // TODO(stage 2+): sendDueMessages, queueReminders, writeHeartbeat, nightlyBackup, dailyDigest.

  console.log(`[cron] pass finished in ${Date.now() - startedAt.getTime()}ms`);
}

main().catch((error) => {
  console.error("[cron] pass failed", error);
  process.exitCode = 1;
});
