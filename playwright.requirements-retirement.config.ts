import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Dedicated ports keep this disposable, non-delivery fixture independent of
// other task/browser runs. Reuse the existing auth and database isolation.
const remap = (value: string) => value.replaceAll("4177", "4277").replaceAll("4178", "4278");
export default defineConfig({
  ...base,
  testMatch: "requirements-retirement.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4277" },
  webServer: (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map(server => ({
    ...server,
    command: remap(server.command),
    url: server.url ? remap(server.url) : undefined,
  })),
});
