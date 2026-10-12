import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./browser-regression",
  testMatch: "uat-isolation.spec.ts",
  timeout: 120_000, workers: 1, fullyParallel: false,
  use: {
    actionTimeout: 15_000,
    baseURL: "http://127.0.0.1:4179",
    launchOptions: existsSync("/repl/tools/bin/chromium") ? { executablePath: "/repl/tools/bin/chromium" } : {},
    trace: "retain-on-failure", screenshot: "only-on-failure",
  },
  webServer: [
    { command: "UAT_E2E_TEST=true ONBOARDING_E2E_TEST=true NODE_ENV=test PORT=4178 artifacts/onboarding-agent/node_modules/.bin/tsx artifacts/api-server/browser-regression-server.mjs",
      url: "http://127.0.0.1:4178/api/test/ready", reuseExistingServer: false, timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 } },
    { command: "VITE_UAT_E2E_AUTH=true ONBOARDING_E2E_TEST=true NODE_ENV=test PORT=4179 artifacts/uat-test-center/node_modules/.bin/vite --config artifacts/uat-test-center/vite.config.ts --host 127.0.0.1",
      url: "http://127.0.0.1:4179/uat/", reuseExistingServer: false, timeout: 120_000 },
  ],
});
