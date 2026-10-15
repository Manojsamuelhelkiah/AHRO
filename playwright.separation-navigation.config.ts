import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Keep this read-only suite independent of the long-running browser workflow.
export default defineConfig({
  ...base,
  testMatch: 'separation-navigation.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4277' },
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(server => ({
    ...server,
    command: server.command.replaceAll('4177', '4277').replaceAll('4178', '4278'),
    url: server.url?.replaceAll('4177', '4277').replaceAll('4178', '4278'),
  })),
});
