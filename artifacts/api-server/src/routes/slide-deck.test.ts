import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import express from "express";
import { createSlideDeckRouter, DECK_DOWNLOADS } from "./slide-deck";

test("architecture downloads use only reviewed immutable exports, with honest failures", async () => {
  const accessed: string[] = [];
  let unavailable = false;
  const app = express();
  app.use(createSlideDeckRouter(((path: string) => {
    accessed.push(path);
    return {
      getMetadata: async () => {
        if (unavailable) throw new Error("storage unavailable");
        return [{ size: 5 }];
      },
      createReadStream: () => Readable.from([Buffer.from("fresh")]),
    };
  }) as any));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const [route, format] of [["/slide-deck?path=private", "pdf"], ["/slide-deck.pptx", "pptx"]] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, format === "pdf" ? /application\/pdf/ : /presentationml/);
      assert.match(response.headers.get("content-disposition")!, new RegExp(`Architecture\\.${format}`));
      assert.equal(response.headers.get("content-length"), "5");
      assert.equal(await response.text(), "fresh");
      assert.equal(accessed.at(-1), DECK_DOWNLOADS[format]);
    }
    unavailable = true;
    const response = await fetch(`http://127.0.0.1:${address.port}/slide-deck`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /temporarily unavailable/);
    assert.ok(accessed.every(path => Object.values(DECK_DOWNLOADS).includes(path as any)));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
