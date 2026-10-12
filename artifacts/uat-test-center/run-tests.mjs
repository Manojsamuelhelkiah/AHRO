import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { globSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
const dir = import.meta.dirname;
rmSync(path.join(dir, "dist-test"), { recursive: true, force: true });
const entries = globSync("src/**/*.test.ts", { cwd: dir }).map(f => path.join(dir, f));
await build({
  entryPoints: entries, outdir: path.join(dir, "dist-test"), bundle: true, platform: "node",
  format: "esm", jsx: "automatic", target: "node20", outExtension: { ".js": ".mjs" },
  external: ["node:*", ...builtinModules],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  alias: { "@": path.join(dir, "src") },
});
const files = globSync("dist-test/**/*.test.mjs", { cwd: dir }).map(f => path.join(dir, f));
process.exit(spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }).status ?? 1);
