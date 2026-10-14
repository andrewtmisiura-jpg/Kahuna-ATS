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
