import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";

// Runs once per `vitest run`: wipes the test database and applies the committed
// migrations, so every test file starts from the real schema.
export default async function globalSetup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error("DATABASE_URL_TEST is not set. Run `pnpm db:local:init` and copy .env.example to .env.");
  }
  if (!/_test\b/.test(new URL(url).pathname)) {
    throw new Error(`Refusing to reset ${url}: the test database name must end in _test`);
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`drop schema if exists public cascade`;
    await client`drop schema if exists drizzle cascade`;
    await client`create schema public`;
  } finally {
    await client.end();
  }

  await runMigrations(url);
}
