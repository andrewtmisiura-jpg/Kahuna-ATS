import { env, loadDotEnv } from "@/config/env";

// db:seed runs once against an empty database (and locally). It will create the
// employer, the first Admin user, both roles and pipelines, the picklists, legal
// text v1, templates v1, snow form v1 (published), window form v1 (draft), both
// openings and the two launch entry codes, keyed so re-running is a no-op.
// See "Seed data for Phase 1" in docs/DATA_MODEL.md. The tables arrive in stage 2.

async function main() {
  loadDotEnv();
  env();
  console.log("[db:seed] nothing to seed yet: the schema lands in stage 2");
}

main().catch((error) => {
  console.error("[db:seed] failed", error);
  process.exit(1);
});
