// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import path from "node:path";
import { prepareDatabaseBackedTests } from "./test-db-setup.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entryPoints = globSync("src/**/*.test.ts", { cwd: dir }).map((f) =>
  path.join(dir, f),
);

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
  ],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);',
  },
});

const result = spawnSync(
  process.execPath,
  [
    "--test",
    path.join(dir, "test-db-setup.test.mjs"),
    path.join(dir, "verify-tenant-safeguards.test.mjs"),
    ...globSync("dist-test/**/*.test.mjs", { cwd: dir }).map((f) =>
      path.join(dir, f),
    ),
  ],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
);
process.exit(result.status ?? 1);
