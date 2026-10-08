// Standalone CI entry point. No database setup, environment credentials or
// provider initialization are permitted in this bundle.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "policy-quality-"));
try {
  const outfile = path.join(dir, "benchmark.test.mjs");
  const result = await build({
    entryPoints: ["src/lib/hr-policy-benchmark.test.ts"], outfile,
    bundle: true, platform: "node", format: "esm", target: "node20", metafile: true,
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(p => /node_modules|hr-policy-ai\.ts|hr-policy-library\.ts|hr-policy-evaluation\.ts/.test(p));
  if (forbidden.length) throw new Error(`Provider-isolation boundary violated: ${forbidden.join(", ")}`);
  const tested = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", env: { PATH: process.env.PATH } });
  process.exitCode = tested.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
