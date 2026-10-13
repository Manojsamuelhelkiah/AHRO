import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

// Dedicated opt-in run: do not revive or depend on the old Cases/intake tests.
process.env.ADMIN_READ_E2E_TEST = "true";
process.env.ADMIN_EDIT_E2E_TEST = "true";
// Exercise the unchanged production same-site/HTTPS guard with real TLS,
// rather than rewriting Origin or weakening the proof middleware.
if (!process.env.ADMIN_EDIT_TLS_DIR) {
  mkdirSync("generated-artifacts", { recursive: true });
  process.env.ADMIN_EDIT_TLS_DIR = path.resolve(mkdtempSync("generated-artifacts/admin-edit-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", `${process.env.ADMIN_EDIT_TLS_DIR}/key.pem`,
    "-out", `${process.env.ADMIN_EDIT_TLS_DIR}/cert.pem`,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
    { stdio: "ignore" });
}
export default defineConfig({
  ...base,
  testMatch: "admin-case-edit.spec.ts",
  retries: 0,
  use: { ...base.use, baseURL: "https://127.0.0.1:4177", ignoreHTTPSErrors: true, video: "off" },
  webServer: (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map(server =>
    server.url === "http://127.0.0.1:4177/" ? { ...server, url: "https://127.0.0.1:4177/", ignoreHTTPSErrors: true } : server),
});
