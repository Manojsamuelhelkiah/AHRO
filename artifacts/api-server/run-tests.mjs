// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entryPoints = globSync("src/**/*.test.ts", { cwd: dir }).map((f) =>
  path.join(dir, f),
);

if (entryPoints.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

await build({
  entryPoints,
  outdir: path.join(dir, "dist-test"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  external: ["node:*", "exceljs", "pg", "@replit/connectors-sdk"],
});

const result = spawnSync(
  process.execPath,
  ["--test", ...globSync("dist-test/**/*.test.mjs", { cwd: dir }).map((f) => path.join(dir, f))],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
