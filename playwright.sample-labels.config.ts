import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Presentation-only, read-only response fixtures: no database or provider writes.
// The ordinary regression config still exercises the same spec with real login.
process.env.SAMPLE_LABELS_UI_ONLY = 'true';
export default defineConfig({
  testDir: './browser-regression',
  testMatch: 'sample-case-labels.spec.ts',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    launchOptions: existsSync('/repl/tools/bin/chromium') ? { executablePath: '/repl/tools/bin/chromium' } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'VITE_E2E_TEST_AUTH=true ONBOARDING_E2E_TEST=true NODE_ENV=test E2E_API_ORIGIN=http://127.0.0.1:4188 PORT=4187 artifacts/onboarding-agent/node_modules/.bin/vite --config artifacts/onboarding-agent/vite.config.ts --host 127.0.0.1',
    url: 'http://127.0.0.1:4187/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
