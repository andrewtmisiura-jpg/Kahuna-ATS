import { loadDotEnv } from "@/config/env";

// `pnpm quo:setup`: the last step of `pnpm db:predeploy`, so it runs before every
// web deploy on Railway (README, Production). It connects the hiring number and
// creates the one Tidepool webhook through ensureQuoConnected
// (src/server/services/messaging/quo-setup.ts), which is idempotent: once both
// are done it makes no API call at all.
//
// A Quo problem must never block a deploy, so this ALWAYS exits 0: a missing
// QUO_API_KEY is a quiet skip, and any warning or failure is logged (redacted)
// and emailed through notifyAdmin (one alert per hour, like every other alert),
// then the deploy carries on. A watchdog ends the run after 90 seconds.

const PREFIX = "[quo:setup]";
const WATCHDOG_MS = 90_000;

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env.QUO_API_KEY?.trim();
  if (!apiKey) {
    console.log(`${PREFIX} QUO_API_KEY is not set; skipped (no text can go out until the hiring number is connected)`);
    return;
  }
  const scrub = (text: string) => text.split(apiKey).join("[redacted]");

  let close: (() => Promise<void>) | null = null;
  let alert: ((body: string) => Promise<unknown>) | null = null;
  try {
    const { db, sql } = await import("@/db");
    close = () => sql.end({ timeout: 5 });
    const { describeQuoSetup, ensureQuoConnected, quoSetupNeedsAttention } = await import("@/server/services/messaging/quo-setup");
    const { notifyAdmin } = await import("@/server/services/notify");
    alert = (body) => notifyAdmin(db, "quo_setup", "Quo setup needs attention", `${body}\n\nSettings > Texting shows the latest result. The deploy went ahead.`);

    const result = await ensureQuoConnected(db, {
      apiKey,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
      apiBaseUrl: process.env.QUO_API_BASE_URL,
    });
    const lines = describeQuoSetup(result).map(scrub);
    for (const line of lines) console.log(`${PREFIX} ${line}`);
    if (quoSetupNeedsAttention(result)) {
      console.warn(`${PREFIX} needs attention; the deploy continues and an alert goes to ALERT_EMAIL`);
      await alert(lines.join("\n\n"));
    } else {
      console.log(`${PREFIX} done`);
    }
  } catch (error) {
    // ensureQuoConnected does not throw; this is the database or a module failing to load.
    const { redactText } = await import("@/server/services/messaging/quo-setup").catch(() => ({ redactText: (text: string) => text }));
    const reason = scrub(redactText(error instanceof Error ? error.message : String(error), [apiKey])).slice(0, 500);
    console.error(`${PREFIX} failed, the deploy continues: ${reason}`);
    // notifyAdmin never throws; with the database down it only logs.
    await alert?.(`quo:setup failed: ${reason}`);
  } finally {
    await close?.().catch(() => {});
  }
}

const watchdog = setTimeout(() => {
  console.error(`${PREFIX} gave up after ${WATCHDOG_MS / 1000}s; the deploy continues`);
  process.exit(0);
}, WATCHDOG_MS);
watchdog.unref();

main()
  .catch(() => {
    console.error(`${PREFIX} failed, the deploy continues`);
  })
  .finally(() => {
    process.exit(0);
  });
