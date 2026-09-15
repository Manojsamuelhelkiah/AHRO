import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-regression",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4177",
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