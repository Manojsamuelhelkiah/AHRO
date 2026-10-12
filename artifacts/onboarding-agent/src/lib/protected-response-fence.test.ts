import assert from "node:assert/strict";
import test from "node:test";
import {
  customFetch, invalidateProtectedResponses,
} from "../../../../lib/api-client-react/src/custom-fetch";

test("a response parsed after a privilege transition cannot restore protected data", async t => {
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { release = resolve; }));
  const request = customFetch("/api/onboarding/cases/1", { responseType: "json" });
  invalidateProtectedResponses();
  release(new Response(JSON.stringify({ workerName: "confidential" }), {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(request, { name: "AbortError" });
});

test("a current-generation response still loads normally", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ workerName: "current" }), {
    headers: { "content-type": "application/json" },
  }));
  assert.deepEqual(await customFetch("/api/onboarding/cases/1", { responseType: "json" }), { workerName: "current" });
});
