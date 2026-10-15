import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

process.env.CASE_LIST_VISIBILITY_E2E_TEST = "true";
export default defineConfig({
  ...base,
  testMatch: "case-list-visibility.spec.ts",
  retries: 0,
  use: { ...base.use, video: "off" },
});
