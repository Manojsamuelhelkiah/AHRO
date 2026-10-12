// Bundles and runs an explicitly selected offline seed script.
import { build } from "esbuild";
import { spawn } from "node:child_process";

await build({
  entryPoints: [process.env.SEED_SCRIPT || "src/scripts/seed-demo-full-coverage.ts"],
  outfile: "dist-test/seed-script.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: [
    "pg",
    "exceljs",
    "@replit/connectors-sdk",
    "pino",
    "pino-http",
    "pino-pretty",
    "thread-stream",
  ],
});

const child = spawn("node", ["--enable-source-maps", "dist-test/seed-script.mjs"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
