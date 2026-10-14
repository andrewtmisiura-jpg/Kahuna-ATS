import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, isProduction } from "@/config/env";
import * as schema from "./schema";

// One connection pool per process. `next dev` re-evaluates modules on reload,
// so the client is parked on globalThis there to avoid leaking pools.
const globalForDb = globalThis as unknown as { tidepoolSql?: postgres.Sql };

export const sql =
  globalForDb.tidepoolSql ??
  postgres(env().DATABASE_URL, {
    max: 10,
    onnotice: () => {},
  });

if (!isProduction()) {
  globalForDb.tidepoolSql = sql;
}

export const db = drizzle({ client: sql, schema, casing: "snake_case" });

// Services take this handle as their first argument. It is either the pool or a
// transaction handle, so a caller can run several service calls in one transaction.
export type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
