import assert from "node:assert/strict";
import { test } from "node:test";
import { taIntakeSignature } from "./ta-intake-auth";

test("TA intake signature binds the canonical event body and source identity", () => {
  const base = {
    secret: "0123456789abcdef0123456789abcdef",
    method: "POST",
    path: "/api/onboarding/ta-intake/events",
    sourceId: "approved-ta",
    timestamp: "1893456000000",
    body: { events: [{ sourceEventId: "event-1", person: { workerEmail: "a@example.test" } }] },
  };
  const sameSemanticBody = {
    ...base,
    body: { events: [{ person: { workerEmail: "a@example.test" }, sourceEventId: "event-1" }] },
  };
  assert.equal(taIntakeSignature(base), taIntakeSignature(sameSemanticBody));
  assert.notEqual(
    taIntakeSignature(base),
    taIntakeSignature({ ...base, sourceId: "other-source" }),
  );
});