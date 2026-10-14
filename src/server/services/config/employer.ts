import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { employer } from "@/db/schema";
import { ConfigError } from "./errors";

export type EmployerRow = typeof employer.$inferSelect;

// Phase 1 has one employer (Kahuna). The configuration screens read it by key
// and fall back to the first live row, so a later Employer row does not break them.
export async function getEmployer(db: Db): Promise<EmployerRow> {
  const [byKey] = await db.select().from(employer).where(eq(employer.key, "kahuna"));
  if (byKey) return byKey;
  const [first] = await db.select().from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
  if (!first) throw new ConfigError("not_found", "No employer row. Run the seed first.");
  return first;
}
