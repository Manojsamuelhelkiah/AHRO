import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Discover configs so newly added workspace frontends are covered too.
const root = path.resolve(import.meta.dirname, "..");
delete process.env.PORT;
delete process.env.BASE_PATH;
process.env.NODE_ENV = "production";
for (const entry of await readdir(path.join(root, "artifacts"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(root, "artifacts", entry.name);
  const configs = (await readdir(dir)).filter(name => /^vite\.config\.[cm]?[jt]s$/.test(name));
  for (const name of configs) {
    const require = createRequire(path.join(dir, "package.json"));
    const { loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
    const file = path.join(dir, name);
    const manifest = await readFile(path.join(dir, ".replit-artifact/artifact.toml"), "utf8");
    const expectedBase = manifest.match(/^previewPath\s*=\s*"([^"]+)"/m)?.[1];
    assert.ok(expectedBase, `${entry.name}: missing public route`);
    const load = async (command, isPreview = false) => {
      const result = await loadConfigFromFile({ command, mode: "production", isPreview }, file, dir, "silent");
      assert.ok(result, `${entry.name}: config did not load`);
      return result.config;
    };
    const build = await load("build");
    assert.equal(build.base, expectedBase, `${entry.name}: production base must match artifact route`);
    process.env.PORT = "invalid-runtime-port";
    await load("build"); // Even an injected server-only value must not break builds.
    process.env.BASE_PATH = "/explicit-override/";
    assert.equal((await load("build")).base, "/explicit-override/");
    delete process.env.BASE_PATH;
    for (const isPreview of [false, true]) {
      for (const value of [undefined, "", "0", "-1", "1.5", "65536", "Infinity", "NaN", "abc"]) {
        if (value === undefined) delete process.env.PORT;
        else process.env.PORT = value;
        await assert.rejects(load("serve", isPreview), /PORT/, `${entry.name}: accepted invalid port ${value}`);
      }
      for (const value of ["1", "22888", "65535"]) {
        process.env.PORT = value;
        const config = await load("serve", isPreview);
        assert.equal(config.server.port, Number(value));
        assert.equal(config.preview.port, Number(value));
      }
    }
    delete process.env.PORT;
    console.log(`PASS ${entry.name}: clean build config, public base, overrides, dev/preview ports`);
  }
}