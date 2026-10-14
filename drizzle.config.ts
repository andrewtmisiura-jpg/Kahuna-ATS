import { defineConfig } from "drizzle-kit";
import { loadDotEnv } from "./src/config/env";

loadDotEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // TypeScript property names are camelCase; columns are snake_case as in DATA_MODEL.md.
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/tidepool",
  },
  strict: true,
  verbose: true,
});
