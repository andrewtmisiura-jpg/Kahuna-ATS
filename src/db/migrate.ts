import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env, loadDotEnv } from "@/config/env";

// Applies the committed SQL migrations in ./drizzle. Railway runs this as the
// pre-deploy command; locally it is `pnpm db:migrate`.
export async function runMigrations(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}

async function main() {
  loadDotEnv();
  await runMigrations(env().DATABASE_URL);
  console.log("[db:migrate] migrations applied");
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  main().catch((error) => {
    console.error("[db:migrate] failed", error);
    process.exit(1);
  });
}
