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
