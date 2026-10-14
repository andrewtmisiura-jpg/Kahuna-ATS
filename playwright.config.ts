import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Pick up .env so the dev server under test sees the same variables as `pnpm dev`.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file
}

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

// Playwright normally downloads its own Chromium. Machines with a preinstalled one
// at /opt/pw-browsers/chromium (or any path in PLAYWRIGHT_CHROMIUM_PATH) use that instead.
const preinstalledChromium = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync(preinstalledChromium) ? preinstalledChromium : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      // Applicant pages are phone-first, so the only viewport is a phone.
      name: "phone",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
