import { defineConfig } from "@playwright/test";
import base from "./playwright.email-intake-refresh.config";

export default defineConfig({
  ...base,
  testMatch: "current-action.spec.ts",
  outputDir: "generated-artifacts/current-action-results",
});
