import test from "node:test";
import assert from "node:assert/strict";
import { listIntents, setBaseUrl } from "@workspace/api-client-react";

test("artifact-base navigation keeps corpus requests on the shared API path", async () => {
  let requested: RequestInfo | URL | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested = input;
    return new Response(JSON.stringify({ intents: [], customIntentsAvailable: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    setBaseUrl(null);
    await listIntents();
    assert.equal(requested, "/api/intents");
    assert.notEqual(requested, "/cost-explorer/api/intents");
    const deployedPage = new URL("https://example.test/cost-explorer/intents");
    const resolvedRequest = new URL(String(requested), deployedPage);
    assert.equal(resolvedRequest.pathname, "/api/intents");
    assert.equal(resolvedRequest.origin, deployedPage.origin);
  } finally {
    globalThis.fetch = originalFetch;
  }
});