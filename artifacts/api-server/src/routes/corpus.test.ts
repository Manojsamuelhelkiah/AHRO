import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import {
  createListIntentsHandler,
  loadCorpusSummary,
  loadIntentCorpus,
} from "./corpus.js";
import { intents } from "../data/intents.js";

test("merges bundled and custom intents when custom storage is healthy", async () => {
  const customRow = {
    id: 72,
    key: "custom-test",
    name: "Custom Test",
    domain: "policy",
    flowClass: "fc2-policy",
    description: "A custom test intent.",
    asIsHandlingMin: 10,
    toBeHumanMin: 2,
    baseWeight: 1,
    actGetActions: 1,
    actPutActions: 0,
    systemsTouchedBase: 1,
    tags: '["custom"]',
    source: "Test fixture",
    author: "Test",
    status: "active",
    registryVersion: "research-v1",
    parentIntentKey: null,
    exactAliases: "[]",
    accountableSpecialist: "HRO Service Owner",
    riskClass: "medium",
    actionSchema: '{"actions":[]}',
    evidenceContract: '{"required":[]}',
    maturity: "catalogued",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await loadIntentCorpus(async () => [customRow]);
  assert.equal(result.customIntentsAvailable, true);
  assert.equal(result.intents.length, intents.length + 1);
  assert.equal(result.intents.at(-1)?.key, "custom-test");
  assert.equal(result.intents.at(-1)?.isCustom, true);
});

test("keeps bundled intents available when custom storage fails", async () => {
  const result = await loadIntentCorpus(async () => {
    throw new Error("relation does not exist");
  });
  assert.equal(result.customIntentsAvailable, false);
  assert.equal(result.intents.length, intents.length);
  assert.ok(result.intents.every((intent) => intent.isCustom === false));
  assert.match(result.warning ?? "", /custom intents could not be loaded/i);
});

test("summary merges active current-version custom intents when storage is healthy", async () => {
  const customRow = {
    id: 72,
    key: "custom-test",
    name: "Custom Test",
    domain: "policy",
    flowClass: "fc2-policy",
    description: "A custom test intent.",
    asIsHandlingMin: 10,
    toBeHumanMin: 2,
    baseWeight: 1,
    actGetActions: 1,
    actPutActions: 0,
    systemsTouchedBase: 1,
    tags: '["custom"]',
    source: "Test fixture",
    author: "Test",
    status: "active",
    registryVersion: "research-v1",
    parentIntentKey: null,
    exactAliases: "[]",
    accountableSpecialist: "HRO Service Owner",
    riskClass: "medium",
    actionSchema: '{"actions":[]}',
    evidenceContract: '{"required":[]}',
    maturity: "catalogued",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const summary = await loadCorpusSummary(async () => [customRow]);

  assert.equal(summary.customIntentsAvailable, true);
  assert.equal(summary.intentCount, intents.length + 1);
  assert.equal(summary.byDomain.find(({ key }) => key === "policy")?.count,
    intents.filter((intent) => intent.domain === "policy").length + 1);
  assert.equal(summary.warning, undefined);
});

test("summary returns reference-only totals when custom storage fails", async () => {
  const summary = await loadCorpusSummary(async () => {
    throw new Error("relation does not exist");
  });

  assert.equal(summary.customIntentsAvailable, false);
  assert.equal(summary.intentCount, intents.length);
  assert.equal(summary.byDomain.reduce((total, bucket) => total + bucket.count, 0), intents.length);
  assert.equal(summary.byFlowClass.reduce((total, bucket) => total + bucket.count, 0), intents.length);
  assert.match(summary.warning ?? "", /reference intents only/i);
});

test("GET /api/intents returns the degraded corpus contract as JSON", async (t) => {
  const app = express();
  app.get("/api/intents", createListIntentsHandler(async () => ({
    intents: intents.map((intent) => ({ ...intent, isCustom: false })),
    customIntentsAvailable: false as const,
    warning: "Built-in reference intents are available, but custom intents could not be loaded. Try again later.",
    customStorageError: new Error("test storage outage"),
  })));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/intents`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const body = await response.json() as {
    intents: Array<{ key: string }>;
    customIntentsAvailable: boolean;
    warning?: string;
    customStorageError?: unknown;
  };
  assert.equal(body.customIntentsAvailable, false);
  assert.equal(body.intents.length, intents.length);
  assert.equal(body.intents[0]?.key, "payslip-copy");
  assert.match(body.warning ?? "", /custom intents could not be loaded/i);
  assert.equal("customStorageError" in body, false);
});