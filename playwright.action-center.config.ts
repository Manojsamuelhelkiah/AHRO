import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Dedicated test ports let this read-only UI regression run without colliding
// with the broader browser workflow. Both backends own disposable schemas.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base, testMatch: "action-center-case-types.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4191" },
  webServer: servers.map(server => ({
    ...server, command: server.command!.replaceAll("4178", "4192").replaceAll("4177", "4191"),
    url: server.url!.replaceAll("4178", "4192").replaceAll("4177", "4191"),
  })),
});
