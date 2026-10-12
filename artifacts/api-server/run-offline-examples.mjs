// Explicit one-off developer command; never part of start, build, or deployment.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";

if (process.env.NODE_ENV !== "development" ||
    process.argv[2] !== "add-60-offline-examples-to-demo") {
  console.error("Development-only operation. Supply the exact Demo offline-inventory confirmation.");
  process.exit(1);
}
await build({
  entryPoints: ["src/scripts/provision-demo-offline-examples.ts"],
  outfile: "dist-test/provision-demo-offline-examples.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["pg", "exceljs", "@replit/connectors-sdk", "pino", "pino-http", "pino-pretty", "thread-stream"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const result = spawnSync(process.execPath, ["dist-test/provision-demo-offline-examples.mjs", process.argv[2]], { stdio: "inherit" });
process.exit(result.status ?? 1);
