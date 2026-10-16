import { defineConfig } from "@playwright/test";
import base from "./playwright.email-intake-refresh.config";

export default defineConfig({
  ...base,
  testMatch: "intake-conversion.spec.ts",
  outputDir: "generated-artifacts/intake-conversion-results",
  webServer: Array.isArray(base.webServer) ? base.webServer.map((server, index) => ({
    ...server,
    command: index === 0 ? `INTAKE_AUTOMATION_BROWSER=true ${server.command}` : server.command,
  })) : base.webServer,
});
