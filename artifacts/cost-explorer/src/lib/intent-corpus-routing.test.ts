import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listIntents, setBaseUrl } from "@workspace/api-client-react";

const costExplorerArtifact = readFileSync(
  path.resolve(process.cwd(), ".replit-artifact/artifact.toml"),
  "utf8",
);
const apiArtifact = readFileSync(
  path.resolve(process.cwd(), "../api-server/.replit-artifact/artifact.toml"),
  "utf8",
);

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

test("artifact manifests route the intents page and API separately in preview and deployment", () => {
  assert.match(costExplorerArtifact, /previewPath\s*=\s*"\/cost-explorer\/"/);
  assert.match(
    costExplorerArtifact,
    /paths\s*=\s*\[\s*"\/cost-explorer\/"\s*\]/,
  );
  assert.match(costExplorerArtifact, /\[services\.development\]/);
  assert.match(costExplorerArtifact, /\[services\.production\]/);
  assert.match(
    costExplorerArtifact,
    /\[\[services\.production\.rewrites\]\][\s\S]*?from\s*=\s*"\/\*"[\s\S]*?to\s*=\s*"\/index\.html"/,
  );

  assert.match(apiArtifact, /previewPath\s*=\s*"\/api"/);
  assert.match(apiArtifact, /paths\s*=\s*\[\s*"\/api"\s*\]/);
  assert.match(apiArtifact, /\[services\.development\]/);
  assert.match(apiArtifact, /\[services\.production\.run\]/);
  assert.match(
    apiArtifact,
    /\[services\.production\.health\.startup\][\s\S]*?path\s*=\s*"\/api\/healthz"/,
  );

  assert.doesNotMatch(costExplorerArtifact, /paths\s*=\s*\[[^\]]*"\/api"/);
});