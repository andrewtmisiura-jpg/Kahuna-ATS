import { loadDotEnv } from "@/config/env";

// The two manual Quo steps, kept for running by hand (the deploy runs both through
// `pnpm quo:setup`; README, Production). Both call the same service as quo:setup
// (src/server/services/messaging/quo-setup.ts), so they are idempotent and print
// only redacted output: never the API key or the webhook secret, and phone
// numbers and Quo ids by their last 4 characters only.
//
// `pnpm quo:connect`: looks the hiring number up in the Quo workspace and stores
// its phone number id on the employer row, which is what the send function uses
// as `from` (DATA_MODEL.md, employer.sms_quo_phone_number_id).
// `pnpm quo:webhook`: creates the one Tidepool webhook, scoped to that number, for
// the four message events, and stores its signing secret in integration_secret,
// where the webhook route reads it. Never touches a webhook Tidepool did not create.
//
// Unlike quo:setup, these exit 1 when the step needs attention.

function manualSteps(url: string | null) {
  return [
    "To create the webhook by hand in Quo instead (Settings > Integrations > Webhooks):",
    `  label:   Tidepool`,
    `  url:     ${url ?? "<PUBLIC_BASE_URL>/api/webhooks/quo"}`,
    "  events:  message.received, message.delivered, message.failed, message.undelivered",
    "  numbers: only the hiring number, 763-292-2259",
    "Then paste the signing secret Quo shows into Railway as QUO_WEBHOOK_SECRET on the web service.",
    "Never change a webhook Tidepool did not create: Typhoon's connection must stay as it is.",
  ].join("\n");
}

async function main() {
  const command = process.argv[2] ?? "connect";
  if (command !== "connect" && command !== "webhook") throw new Error("usage: pnpm quo:connect | pnpm quo:webhook");
  loadDotEnv();
  const apiKey = process.env.QUO_API_KEY?.trim();
  if (!apiKey) throw new Error("QUO_API_KEY is not set. Create an API key labeled Tidepool in Quo and put it in .env or Railway.");

  const { db, sql } = await import("@/db");
  const { ensureQuoPhone, ensureQuoWebhook } = await import("@/server/services/messaging/quo-setup");
  const options = { apiKey, publicBaseUrl: process.env.PUBLIC_BASE_URL, apiBaseUrl: process.env.QUO_API_BASE_URL };
  const scrub = (text: string) => text.split(apiKey).join("[redacted]");
  try {
    if (command === "connect") {
      const phone = await ensureQuoPhone(db, options);
      console.log(`[quo:connect] ${phone.status}: ${scrub(phone.message)}`);
      if (phone.status === "not_found" || phone.status === "error") process.exitCode = 1;
      else {
        const { getTextingSettings } = await import("@/server/services/config/texting");
        const texting = await getTextingSettings(db);
        console.log(`[quo:connect] texting ${texting.smsEnabled ? "is on" : "stays off until Settings > Texting turns it on"}`);
      }
    } else {
      const webhook = await ensureQuoWebhook(db, options);
      console.log(`[quo:webhook] ${webhook.status}: ${scrub(webhook.message)}`);
      if (webhook.status === "error" || webhook.status === "exists_without_secret") {
        if (webhook.status === "error") console.log(manualSteps(webhook.url));
        process.exitCode = 1;
      }
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  const apiKey = process.env.QUO_API_KEY?.trim();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[quo:${process.argv[2] ?? "connect"}] failed:`, apiKey ? message.split(apiKey).join("[redacted]") : message);
  process.exit(1);
});
