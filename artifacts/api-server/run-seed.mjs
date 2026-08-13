// Bundles and runs the volunteer seeding script (same esbuild harness as tests).
import { build } from "esbuild";
import { spawn } from "node:child_process";

await build({
  entryPoints: ["src/scripts/seed-volunteers.ts"],
  outfile: "dist-test/seed-volunteers.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: ["pg", "exceljs", "@replit/connectors-sdk"],
});

const child = spawn("node", ["--enable-source-maps", "dist-test/seed-volunteers.mjs"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
