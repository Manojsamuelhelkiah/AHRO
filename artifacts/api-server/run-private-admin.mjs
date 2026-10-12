import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
const output = new URL("./.private-admin-cli.mjs", import.meta.url);
try {
  await build({
    entryPoints: [new URL("./src/scripts/approve-private-platform-admin.ts", import.meta.url).pathname],
    outfile: output.pathname, bundle: true, platform: "node", format: "esm",
    external: ["@clerk/express", "pg", "pino", "@replit/connectors-sdk", "exceljs"],
  });
  const result = spawnSync(process.execPath, [output.pathname, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(output, { force: true }); }
