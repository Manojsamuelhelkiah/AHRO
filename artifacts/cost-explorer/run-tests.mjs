// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { globSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const requested = process.argv.slice(2);
const discovered = requested.length > 0
  ? requested
  : [
      ...globSync("src/**/*.test.ts", { cwd: dir }),
      ...globSync("src/**/*.test.tsx", { cwd: dir }),
      ...globSync("scripts/**/*.test.mjs", { cwd: dir }),
    ]
const scriptTests = discovered
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.resolve(dir, f));
const entryPoints = discovered
  .filter((f) => !f.endsWith(".mjs"))
  .map((f) => path.resolve(dir, f));

if (entryPoints.length === 0 && scriptTests.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

rmSync(path.join(dir, "dist-test"), { recursive: true, force: true });
if (entryPoints.length > 0) await build({
  entryPoints,
  outdir: path.join(dir, "dist-test"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  jsx: "automatic",
  // Keep the DOM runtime's package-relative resources intact. React's act
  // needs native module.require to schedule Node tasks; bundling React makes
  // it fall back to browser MessageChannels that keep the test worker alive.
  external: ["node:*", ...builtinModules, "happy-dom", "react"],
  // react-dom/server (cjs) does require("util") etc.; when bundled to esm the
  // externalized require needs a real implementation.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

const result = spawnSync(
  process.execPath,
  ["--test", ...scriptTests, ...(requested.length > 0
    ? entryPoints.map((f) => path.join(dir, "dist-test", `${path.basename(f).replace(/\.(?:ts|tsx)$/, "")}.mjs`))
    : globSync("dist-test/**/*.test.mjs", { cwd: dir }).map((f) => path.join(dir, f)))],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
