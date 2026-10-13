import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createIntentCatalogRouter } from "./intent-catalog";

test("GET list/export parity, private caching, exact detail, unknown and no execution methods", async () => {
  const calls: string[] = [];
  const app = express();
  app.use((req, _res, next) => { Object.assign(req, { organizationId: "catalog-fixture" }); next(); });
  app.use(createIntentCatalogRouter(async organizationId => { calls.push(organizationId); return []; }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${base}/intent-catalog`);
    assert.equal(list.status, 200); assert.equal(list.headers.get("cache-control"), "private, no-store");
    const inventory = await list.json();
    const exported = await fetch(`${base}/intent-catalog/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition")!, /attachment.*hro-operational-v1.json/);
    assert.deepEqual(await exported.json(), inventory);
    const detail = await fetch(`${base}/intent-catalog/definitions/provision-role-access`);
    assert.equal(detail.status, 200); assert.equal((await detail.json() as { key: string }).key, "provision-role-access");
    assert.equal((await fetch(`${base}/intent-catalog/definitions/unknown`)).status, 404);
    const priorCalls = calls.length;
    for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await fetch(`${base}/intent-catalog`, { method })).status, 404);
    assert.equal(calls.length, priorCalls);
    assert.ok(calls.every(scope => scope === "catalog-fixture"));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
