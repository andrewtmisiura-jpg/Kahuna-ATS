import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { appliedChange, appUser } from "@/db/schema";
import { staffActor } from "@/server/services/actor";
import type { Change, Tx } from "./types";

// Applies pending one-time content changes in order (README, `pnpm db:changes`).
// Each change runs in its own transaction that first takes a Postgres advisory
// lock, then checks applied_change, so two deploys running at once apply a
// change exactly once. The change and its applied_change row commit together:
// a failure rolls both back and the next run tries again. Safe on every deploy.

export type ChangeReport = {
  applied: string[];
  // Already in applied_change.
  skipped: string[];
};

export class ChangeError extends Error {
  constructor(
    readonly changeId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChangeError";
  }
}

// One lock for the whole runner, derived from a fixed name.
const LOCK = sql`select pg_advisory_xact_lock(hashtext('tidepool:db:changes'))`;

// The earliest-created active Admin acts for every change.
export async function changeActor(tx: Tx): Promise<{ id: string; email: string }> {
  const [admin] = await tx
    .select({ id: appUser.id, email: appUser.email })
    .from(appUser)
    .where(and(eq(appUser.role, "admin"), eq(appUser.status, "active")))
    .orderBy(asc(appUser.createdAt), asc(appUser.id))
    .limit(1);
  if (!admin) {
    throw new Error("No active Admin in app_user to record these changes as. Run `pnpm db:seed` or `pnpm user:add-admin <email>` first.");
  }
  return admin;
}

export async function runChanges(db: Db, changes: readonly Change[], log: (line: string) => void = () => {}): Promise<ChangeReport> {
  const ids = new Set<string>();
  for (const change of changes) {
    if (ids.has(change.id)) throw new ChangeError(change.id, `Change ${change.id} is listed twice in src/db/changes/index.ts`);
    ids.add(change.id);
  }

  const report: ChangeReport = { applied: [], skipped: [] };
  for (const change of changes) {
    const outcome = await db
      .transaction(async (tx) => {
        await tx.execute(LOCK);
        const [done] = await tx.select().from(appliedChange).where(eq(appliedChange.id, change.id));
        if (done) return "skipped" as const;
        const admin = await changeActor(tx);
        log(`applying ${change.id}: ${change.description} (as ${admin.email})`);
        await change.run(tx, { actor: staffActor(admin.id), actorEmail: admin.email, log: (line) => log(`  ${line}`) });
        await tx.insert(appliedChange).values({ id: change.id, description: change.description });
        return "applied" as const;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ChangeError(change.id, `Change ${change.id} failed and was rolled back: ${reason}`, { cause: error });
      });
    report[outcome].push(change.id);
    log(outcome === "applied" ? `applied ${change.id}` : `already applied: ${change.id}`);
  }
  return report;
}
