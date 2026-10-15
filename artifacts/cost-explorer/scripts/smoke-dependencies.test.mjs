import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDependencyOrchestrator,
  DEFAULT_SMOKE_API_URL,
  DEFAULT_SMOKE_WEB_URL,
} from "./smoke-dependencies.mjs";

test("fallback test servers cannot claim the managed API or frontend ports", () => {
  const api = new URL(DEFAULT_SMOKE_API_URL);
  const web = new URL(DEFAULT_SMOKE_WEB_URL);
  assert.equal(api.hostname, "127.0.0.1");
  assert.equal(web.hostname, "127.0.0.1");
  assert.notEqual(api.port, web.port);
  for (const url of [api, web]) {
    assert.notEqual(url.port, "8080");
    assert.notEqual(url.port, "18940");
  }
});

const fixture = fileURLToPath(
  new URL("./fixtures/smoke-dependency-fixture.mjs", import.meta.url),
);

function harness(t, { timeout = 400, ready = new Set() } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-dependencies-"));
  const lifecycle = path.join(dir, "lifecycle.log");
  const orchestrator = createDependencyOrchestrator({
    workspaceRoot: dir,
    startupTimeoutMs: timeout,
    retryDelayMs: 10,
    probe: async (url) =>
      ready.has(url.href) ||
      existsSync(path.join(dir, `${url.hostname.split(".")[0]}.ready`)),
    logger: { log() {} },
  });
  t.after(async () => {
    orchestrator.stopSpawnedDependencies();
    await new Promise((resolve) => setTimeout(resolve, 80));
    rmSync(dir, { recursive: true, force: true });
  });
  const dependency = (name, mode = "ready") => ({
    name,
    command: [
      fixture,
      mode,
      path.join(dir, `${name.toLowerCase()}.ready`),
      lifecycle,
    ],
    executable: process.execPath,
  });
  return { dir, lifecycle, orchestrator, dependency };
}

test("cold start launches both missing dependencies and cleans them up", async (t) => {
  const { lifecycle, orchestrator, dependency } = harness(t);
  const web = new URL("http://web.local/ready");
  const api = new URL("http://api.local/ready");

  await Promise.all([
    orchestrator.waitForDependency({
      name: "Web",
      urls: [web],
      expectedContentType: "text/html",
      start: dependency("web"),
    }),
    orchestrator.waitForDependency({
      name: "API",
      urls: [api],
      expectedContentType: "application/json",
      start: dependency("api"),
    }),
  ]);
  assert.equal(orchestrator.spawnedDependencies.length, 2);
  assert.equal(
    readFileSync(lifecycle, "utf8").match(/^started:/gm)?.length,
    2,
  );

  orchestrator.stopSpawnedDependencies();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    readFileSync(lifecycle, "utf8").match(/^stopped:/gm)?.length,
    2,
  );
});

test("warm dependencies are reused without spawning duplicates", async (t) => {
  const url = new URL("http://warm.local/ready");
  const { orchestrator, dependency } = harness(t, {
    ready: new Set([url.href]),
  });
  assert.equal(
    await orchestrator.waitForDependency({
      name: "Warm",
      urls: [url],
      expectedContentType: "text/html",
      start: dependency("warm"),
    }),
    url,
  );
  assert.equal(orchestrator.spawnedDependencies.length, 0);
});

test("startup timeout is bounded and includes dependency details", async (t) => {
  const { orchestrator, dependency } = harness(t, { timeout: 80 });
  const started = Date.now();
  await assert.rejects(
    orchestrator.waitForDependency({
      name: "Hung API",
      urls: [new URL("http://hung.local/ready")],
      expectedContentType: "application/json",
      start: dependency("hung", "hang"),
    }),
    /Timed out after 80ms waiting for Hung API at http:\/\/hung\.local\/ready/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("early process exit reports its code and captured output", async (t) => {
  const { orchestrator, dependency } = harness(t);
  await assert.rejects(
    orchestrator.waitForDependency({
      name: "Broken Web",
      urls: [new URL("http://broken.local/ready")],
      expectedContentType: "text/html",
      start: dependency("broken", "exit"),
    }),
    (error) => {
      assert.match(error.message, /Broken Web exited with code 23/);
      assert.match(error.message, /fixture failed before readiness/);
      return true;
    },
  );
});