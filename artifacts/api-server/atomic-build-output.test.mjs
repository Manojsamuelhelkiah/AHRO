import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishBuildOutputs } from "./atomic-build-output.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "api-atomic-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "index.mjs");
  await writeFile(entry, "old entry");
  return { directory, entry };
}

test("publishes complete entry and worker files without leftover staging files", async t => {
  const { directory, entry } = await fixture(t);
  const worker = path.join(directory, "worker.mjs");
  await publishBuildOutputs([
    { path: entry, contents: Buffer.from("new entry") },
    { path: worker, contents: Buffer.from("new worker") },
  ], entry);
  assert.equal(await readFile(entry, "utf8"), "new entry");
  assert.equal(await readFile(worker, "utf8"), "new worker");
  assert.deepEqual((await readdir(directory)).sort(), ["index.mjs", "worker.mjs"]);
});

test("staging failure leaves the previous entry untouched and cleans temporary files", async t => {
  const { directory, entry } = await fixture(t);
  const blocker = path.join(directory, "not-a-directory");
  await writeFile(blocker, "blocker");
  await assert.rejects(publishBuildOutputs([
    { path: entry, contents: Buffer.from("new entry") },
    { path: path.join(blocker, "worker.mjs"), contents: Buffer.from("worker") },
  ], entry));
  assert.equal(await readFile(entry, "utf8"), "old entry");
  assert.deepEqual((await readdir(directory)).sort(), ["index.mjs", "not-a-directory"]);
});

test("rejects missing entry before changing outputs", async t => {
  const { entry } = await fixture(t);
  await assert.rejects(publishBuildOutputs([], entry), /entry point/);
  assert.equal(await readFile(entry, "utf8"), "old entry");
});

test("concurrent builds expose only complete entries to readers", async t => {
  const { directory, entry } = await fixture(t);
  const variants = ["old entry", "A".repeat(2_000_000), "B".repeat(2_000_000)];
  let finished = false;
  const builds = Promise.all(variants.slice(1).map(text => publishBuildOutputs([
    { path: entry, contents: Buffer.from(text) },
  ], entry))).finally(() => { finished = true; });
  do {
    assert.ok(variants.includes(await readFile(entry, "utf8")), "entry must never be partial");
  } while (!finished);
  await builds;
  assert.ok(variants.slice(1).includes(await readFile(entry, "utf8")));
  assert.deepEqual(await readdir(directory), ["index.mjs"]);
});
