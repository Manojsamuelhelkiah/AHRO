import assert from "node:assert/strict";
import test from "node:test";
import { customFetch, invalidateProtectedResponses, setApiResponseObserver } from "@workspace/api-client-react";

test("a delayed old-session denial cannot clear a newly verified session", async () => {
  const original = globalThis.fetch;
  let release!: (response: Response) => void;
  let observed = 0;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  setApiResponseObserver(() => { observed++; });
  try {
    const pending = customFetch("/api/onboarding/email-intake", { responseType: "json" });
    invalidateProtectedResponses();
    release(new Response(JSON.stringify({ code: "ADMIN_REVOKED" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(observed, 0);
  } finally {
    globalThis.fetch = original;
    setApiResponseObserver(null);
  }
});
