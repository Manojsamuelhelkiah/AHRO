import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// Nix environments provide a runnable Chromium; Playwright's downloaded Linux
// binary is not always present or compatible. Other environments keep the
// standard Playwright-managed browser unless an explicit override is supplied.
const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./browser-regression",
  testIgnore: "uat-isolation.spec.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4177",
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "ONBOARDING_E2E_TEST=true NODE_ENV=test PORT=4178 artifacts/onboarding-agent/node_modules/.bin/tsx artifacts/api-server/browser-regression-server.mjs",
      url: "http://127.0.0.1:4178/api/test/ready",
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command:
        "VITE_E2E_TEST_AUTH=true ONBOARDING_E2E_TEST=true NODE_ENV=test E2E_API_ORIGIN=http://127.0.0.1:4178 PORT=4177 artifacts/onboarding-agent/node_modules/.bin/vite --config artifacts/onboarding-agent/vite.config.ts --host 127.0.0.1",
      url: "http://127.0.0.1:4177/",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});