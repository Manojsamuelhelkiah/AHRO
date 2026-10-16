// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync, spawn } from "node:child_process";
import { createIsolatedTestDatabase } from "./isolated-test-database.mjs";
import { globSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import path from "node:path";
import { prepareDatabaseBackedTests } from "./test-db-setup.mjs";

// Existing privacy-boundary suites exercise Active deliberately. Product
// runtimes default to Deferred regardless of development/production.
process.env.HRO_PRIVACY_ENFORCEMENT_DEFAULT ??= "active";

const dir = path.dirname(fileURLToPath(import.meta.url));
rmSync(path.join(dir, "dist-test"), { recursive: true, force: true });
const requestedTestFile = process.env.TEST_FILE?.trim();
// Only suites proven to create workspace leftovers, plus workspace bootstrap/
// membership regressions. Broad API-suite isolation is a separate deliverable.
const ownedWorkspaceSuites = new Set([
  "src/lib/onboarding/demo-job-profiles.test.ts",
  "src/routes/workforce-insights.test.ts",
  "src/lib/flow-manager/contract.test.ts",
  "src/lib/onboarding/channel-flow-action.test.ts",
  "src/lib/flow-manager/manager.test.ts",
  "src/lib/onboarding/effect-journal.test.ts",
  "src/lib/onboarding/gateway-guards.test.ts",
  "src/lib/onboarding/engine-document-gate.test.ts",
  "src/lib/onboarding/case-list-visibility.test.ts",
  "src/routes/action-center-case-types.test.ts",
  "src/routes/action-center.test.ts",
  "src/lib/onboarding/action-conversations.test.ts",
  "src/lib/transaction-context/transaction-context.test.ts",
  "src/lib/onboarding/case-explainability-evidence.test.ts",
  "src/routes/onboarding-case-explainability.test.ts",
  "src/lib/agent-invocation.test.ts",
  "src/routes/agent-catalogue.test.ts",
  "src/lib/onboarding/frontline-operations.db.test.ts",
  "src/lib/private-platform-admin.test.ts",
  "src/lib/onboarding/controller-retirement.test.ts",
  "src/lib/onboarding/operational-generation.test.ts",
  "src/lib/onboarding/case-derived-sensitive-lifecycle.test.ts",
  "src/lib/onboarding/requirements-retirement.test.ts",
  "src/lib/onboarding/governance.test.ts",
  "src/lib/onboarding/governance-runtime.test.ts",
  "src/lib/onboarding/workstream-connectors.test.ts",
  "src/lib/offboarding/offboarding.test.ts",
  "src/lib/offboarding/exchange-runtime.test.ts",
  "src/lib/client-administrator-access.test.ts",
  "src/lib/privacy-enforcement.test.ts",
  "src/lib/hr-policy-imports.test.ts",
  "src/lib/onboarding/client-operations-settings.test.ts",
  "src/routes/user-group-super-admin.test.ts",
  "src/lib/hro-email-intake.test.ts",
  "src/lib/intake-conversion.test.ts",
  "src/lib/hro-email-turnaround.test.ts",
  "src/routes/email-intake-access.test.ts",
  "src/lib/onboarding/decision-authority.test.ts",
  "src/lib/onboarding/approval-versioning.test.ts",
  "src/routes/onboarding-gate-routes.test.ts",
  "src/routes/onboarding-evidence.test.ts",
  "src/routes/candidate-portal-security.test.ts",
  "src/lib/onboarding/operational-requests.test.ts",
  "src/routes/organization-isolation.test.ts",
  "src/routes/organizations-membership.test.ts",
  "src/routes/organizations.test.ts",
]);
if (process.env.REQUIRE_ISOLATED_TEST_SCHEMA === "true" && !ownedWorkspaceSuites.has(requestedTestFile)) {
  throw new Error("Selected regression suite is not registered for disposable-schema isolation");
}
if (ownedWorkspaceSuites.has(requestedTestFile) && !process.argv.includes("--isolated-child")) {
  const owned = await createIsolatedTestDatabase(process.env.DATABASE_URL);
  let child;
  process.once("SIGTERM", () => child?.kill("SIGTERM"));
  process.once("SIGINT", () => child?.kill("SIGINT"));
  let status = 1;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--isolated-child"], {
      stdio: "inherit", env: { ...process.env, DATABASE_URL: owned.connectionString },
    });
    status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
  } finally {
    await owned.dispose();
  }
  process.exit(status);
}
const allEntryPoints = globSync("src/**/*.test.ts", { cwd: dir }).map((f) =>
  path.join(dir, f),
);
const entryPoints = requestedTestFile
  ? allEntryPoints.filter((file) => path.relative(dir, file) === requestedTestFile)
  : allEntryPoints.filter(file => !ownedWorkspaceSuites.has(path.relative(dir, file)));

if (entryPoints.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

if (!process.argv.includes("--isolated-child")) await prepareDatabaseBackedTests();

await build({
  entryPoints: requestedTestFile === "src/lib/intake-conversion.test.ts"
    ? [...entryPoints, path.join(dir, "src/test-support/intake-conversion-child.ts")] : entryPoints,
  outdir: path.join(dir, "dist-test"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  external: [
    "node:*",
    ...builtinModules,
    "exceljs",
    "pg",
    "@replit/connectors-sdk",
    "pino",
    "pino-http",
    "pino-pretty",
    "thread-stream",
  ],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);',
  },
});

const requestedBgvOnly = requestedTestFile?.endsWith("bgv-notifications.test.ts");
const result = requestedBgvOnly ? { status: 0 } : spawnSync(
  process.execPath,
  [
    "--test",
    ...(requestedTestFile ? [] : [
      path.join(dir, "test-db-setup.test.mjs"),
      path.join(dir, "start-production.test.mjs"),
      path.join(dir, "verify-tenant-safeguards.test.mjs"),
      path.join(dir, "publish-safeguard-alert.test.mjs"),
      path.join(dir, "browser-regression-identities.test.mjs"),
    ]),
    ...globSync("dist-test/**/*.test.mjs", { cwd: dir }).filter((f) => !f.endsWith("/bgv-notifications.test.mjs")).map((f) =>
      path.join(dir, f),
    ),
  ],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "production", ONBOARDING_AUTOMATED_TEST: "true" } },
);
// This provider-stubbed suite explicitly requires development semantics.
// Keep all other suites on their established production-mode harness.
const bgvFile = globSync("dist-test/**/bgv-notifications.test.mjs", { cwd: dir })[0];
const bgvResult = !requestedTestFile || requestedBgvOnly
  ? spawnSync(process.execPath, ["--test", path.join(dir, bgvFile)], {
    stdio: "inherit", env: { ...process.env, NODE_ENV: "development", ONBOARDING_AUTOMATED_TEST: "true" },
  })
  : { status: 0 };
let workspaceStatus = 0;
if (!requestedTestFile) {
  for (const file of ownedWorkspaceSuites) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: "inherit", env: { ...process.env, NODE_ENV: "test", TEST_FILE: file },
    });
    workspaceStatus ||= run.status ?? 1;
  }
}
process.exit((result.status ?? 1) || (bgvResult.status ?? 1) || workspaceStatus);
