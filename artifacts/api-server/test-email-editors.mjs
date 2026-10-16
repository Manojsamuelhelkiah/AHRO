// Pure offline suite: no DB setup, credentials, providers, model SDKs or renderer.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const allowedSources = new Set([
  "src/lib/hro-email-editor-compatibility.test.ts",
  "src/lib/hro-email-content.ts",
  "src/lib/hro-email-structure.ts",
  "src/lib/hro-email-registry.ts",
  "src/lib/onboarding/hro-batch-templates.ts",
  "src/lib/onboarding/provider-policy.ts",
  "src/test-utils/hro-email-editor-fixtures.ts",
]);
const allowedBuiltins = new Set(["node:assert/strict", "node:test", "node:crypto", "node:async_hooks"]);
const dir = mkdtempSync(path.join(tmpdir(), "email-editor-compatibility-"));
try {
  const outfile = path.join(dir, "editors.test.mjs");
  const result = await build({
    entryPoints: ["src/lib/hro-email-editor-compatibility.test.ts"], outfile,
    bundle: true, platform: "node", format: "esm", target: "node20", metafile: true,
    plugins: [{
      name: "offline-import-boundary",
      setup(builder) {
        builder.onLoad({ filter: /.*/ }, args => {
          const relative = path.relative(process.cwd(), args.path).replaceAll("\\", "/");
          const tokenizerDependency = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:htmlparser2|domhandler|domutils|domelementtype|entities|dom-serializer)\//.test(`/${relative}`);
          if (!allowedSources.has(relative) && !tokenizerDependency) throw new Error(`Offline corpus forbids loading ${relative}`);
        });
      },
    }],
  });
  for (const output of Object.values(result.metafile.outputs)) for (const imp of output.imports) {
    if (imp.external && !allowedBuiltins.has(imp.path)) throw new Error(`Offline corpus forbids external import ${imp.path}`);
  }
  const guard = path.join(dir, "deny-network.cjs");
  writeFileSync(guard, `
    let attempts = 0;
    const deny = () => { attempts++; throw new Error("Offline email corpus forbids network/provider/model calls"); };
    globalThis.fetch = deny;
    globalThis.WebSocket = class { constructor() { deny(); } };
    for (const [name, methods] of [
      ["node:http", ["request", "get"]],
      ["node:https", ["request", "get"]],
      ["node:net", ["connect", "createConnection", "Socket.prototype.connect"]],
      ["node:tls", ["connect"]],
      ["node:dgram", ["createSocket"]],
      ["node:dns", ["lookup", "resolve"]],
      ["node:dns/promises", ["lookup", "resolve"]],
    ]) {
      const module = require(name);
      for (const method of methods) {
        const keys = method.split(".");
        let owner = module;
        for (const key of keys.slice(0, -1)) owner = owner[key];
        owner[keys.at(-1)] = deny;
      }
    }
    require("node:module").syncBuiltinESMExports();
    process.on("exit", () => {
      if (attempts) { console.error("Forbidden network attempts:", attempts); process.exitCode = 1; }
    });
  `);
  const tested = spawnSync(process.execPath, ["--require", guard, "--test", outfile], {
    stdio: "inherit", env: { PATH: process.env.PATH, NODE_ENV: "test" },
  });
  process.exitCode = tested.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
