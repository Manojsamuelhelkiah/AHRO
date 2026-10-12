import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { policyDocumentUpload } from "./hr-policies";
import { POLICY_IMPORT_MAX_BYTES } from "../lib/hr-policy-document-extraction";

test("multipart accepts one file and rejects extra files, fields, and actual oversized bytes", async () => {
  const app = express();
  app.post("/upload", (req, res) => policyDocumentUpload(req, res, (error) => {
    if (error || !req.file) res.status(400).json({ rejected: true });
    else res.json({ bytes: req.file.buffer.length, name: req.file.originalname });
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/upload`;
  const pdf = new Blob(["%PDF-1.4 fixture"], { type: "application/pdf" });
  try {
    const one = new FormData(); one.append("file", pdf, "fixture.pdf");
    const accepted = await fetch(url, { method: "POST", body: one });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { bytes: 16, name: "fixture.pdf" });
    const two = new FormData(); two.append("file", pdf, "a.pdf"); two.append("file", pdf, "b.pdf");
    assert.equal((await fetch(url, { method: "POST", body: two })).status, 400);
    const field = new FormData(); field.append("file", pdf, "a.pdf"); field.append("extra", "not allowed");
    assert.equal((await fetch(url, { method: "POST", body: field })).status, 400);
    const big = new FormData(); big.append("file", new Blob([Buffer.alloc(POLICY_IMPORT_MAX_BYTES + 1)]), "big.pdf");
    assert.equal((await fetch(url, { method: "POST", body: big })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
