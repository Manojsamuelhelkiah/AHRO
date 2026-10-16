import { defineConfig } from "@playwright/test";
import admin from "./playwright.admin-edit.config";

// Reuse the disposable provider-denied server and verified administrator
// fixture; run only the focused workforce-insights test.
export default defineConfig({
  ...admin,
  testMatch: "workforce-insights.spec.ts",
  retries: 0,
});
