import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pick up .env for local runs; CI and Railway set the variables themselves.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file
}

const testDatabaseUrl = process.env.DATABASE_URL_TEST ?? "postgres://postgres@127.0.0.1:54329/tidepool_test";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Tests share one database, so files run one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // Everything under src reads DATABASE_URL; tests point it at the test database.
      DATABASE_URL: testDatabaseUrl,
      DATABASE_URL_TEST: testDatabaseUrl,
      // notifyAdmin needs an address; tests pass a sink provider so nothing is sent.
      ALERT_EMAIL: "alerts@example.test",
      MESSAGE_PROVIDERS: "sink",
      // Scoring uses the deterministic fake, and no Anthropic key reaches a test even
      // when .env holds one (a blank value counts as unset).
      SCORING_PROVIDER: "fake",
      ANTHROPIC_API_KEY: "",
      // Signs the door check-in kiosk's tokens; a fixed test value, whatever .env holds.
      BETTER_AUTH_SECRET: "test-only-secret-never-used-outside-vitest",
    },
  },
});
