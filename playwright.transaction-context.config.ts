import { defineConfig } from "@playwright/test";
import base from "./playwright.admin-edit.config";

process.env.TRANSACTION_CONTEXT_E2E_TEST = "true";
export default defineConfig({
  ...base,
  testMatch: "transaction-context.spec.ts",
  retries: 0,
  use: { ...base.use, video: "off" },
});
