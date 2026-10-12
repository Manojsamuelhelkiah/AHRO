import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import catalogRouter from "./onboarding-batch-catalog";

test("blank catalogs require authenticated tenant context, not intake write grants", async t => {
  const app = express();
  // Isolated middleware simulates the trusted parent tenant resolver, never
  // mounted in the real app. This test has no database or delivery providers.
  let context: "signed-out" | "no-organization" | "member" = "signed-out";
  app.use((req, _res, next) => {
    if (context !== "signed-out") req.authUserId = "fictional-test-member";
    if (context === "member") req.organizationId = "fictional-test-organization";
    next();
  });
  app.use(catalogRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/onboarding/batch-upload/templates`;
  assert.equal((await fetch(base)).status, 401);
  context = "no-organization";
  assert.equal((await fetch(base)).status, 403);
  context = "member";
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const templates = await response.json() as Array<{ id: string; family: string }>;
  assert.equal(templates.length, 14);
  assert.equal(new Set(templates.map(template => template.family)).size, 12);
  for (const format of ["csv", "xlsx"]) {
    const file = await fetch(`${base}/${templates[0].id}/download?format=${format}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("cache-control"), "no-store");
    assert.match(file.headers.get("content-disposition")!, /attachment;/);
    assert.ok((await file.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(`${base}/unknown/download?format=csv`)).status, 400);
  context = "signed-out";
  assert.equal((await fetch(`${base}/${templates[0].id}/download?format=csv`)).status, 401);
});
