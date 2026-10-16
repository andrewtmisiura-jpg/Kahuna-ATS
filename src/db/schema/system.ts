import { pgTable, text } from "drizzle-orm/pg-core";
import { id, timestamptz } from "./columns";

// The cron service's heartbeat, read by /health (200 only when the newest beat
// is under 15 minutes old). Not in DATA_MODEL.md, which describes the heartbeat
// without naming a table; one row per job name.
export const cronHeartbeat = pgTable("cron_heartbeat", {
  id: id(),
  name: text().notNull().unique(),
  beatAt: timestamptz().notNull(),
});

// One row per one-time content change that `pnpm db:changes` has applied
// (src/db/changes). The id is the change's own stable name, not a UUID, and it
// is inserted in the same transaction as the change, so a change runs once.
export const appliedChange = pgTable("applied_change", {
  id: text().primaryKey(),
  description: text().notNull(),
  appliedAt: timestamptz().notNull().defaultNow(),
});

// Secrets an integration hands Tidepool once, stored so nobody copies them by
// hand: today only `quo_webhook_secret`, written by `pnpm quo:setup` in the same
// run that creates the Quo webhook (DATA_MODEL.md, integration_secret). Only the
// server reads it (src/server/services/integration-secrets.ts); it is never sent
// to the browser, exported, written to CSV or audit payloads, or logged.
export const integrationSecret = pgTable("integration_secret", {
  key: text().primaryKey(),
  value: text().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  // Where the value came from, in plain words; never part of the secret.
  note: text(),
});
