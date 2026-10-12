// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { globSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import path from "node:path";
import { prepareDatabaseBackedTests } from "./test-db-setup.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
rmSync(path.join(dir, "dist-test"), { recursive: true, force: true });
const requestedTestFile = process.env.TEST_FILE?.trim();
const allEntryPoints = globSync("src/**/*.test.ts", { cwd: dir }).map((f) =>
  path.join(dir, f),
);
const entryPoints = requestedTestFile
  ? allEntryPoints.filter((file) => path.relative(dir, file) === requestedTestFile)
  : allEntryPoints;

if (entryPoints.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

await prepareDatabaseBackedTests();

await build({
  entryPoints,
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
process.exit((result.status ?? 1) || (bgvResult.status ?? 1));
