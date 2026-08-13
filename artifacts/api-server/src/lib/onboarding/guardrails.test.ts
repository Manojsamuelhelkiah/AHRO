import { test } from "node:test";
import assert from "node:assert/strict";
import { GUARDRAILS, GUARDRAIL_CATEGORIES, getGuardrail } from "./guardrails";

test("guardrail keys are unique", () => {
  const keys = GUARDRAILS.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every guardrail belongs to a known category", () => {
  for (const g of GUARDRAILS) {
    assert.ok(GUARDRAIL_CATEGORIES[g.category], `unknown category ${g.category} on ${g.key}`);
  }
});

test("every guardrail is fully documented", () => {
  for (const g of GUARDRAILS) {
    assert.ok(g.title.length > 0 && g.threat.length > 0 && g.mechanism.length > 0 && g.onViolation.length > 0, g.key);
    assert.ok(g.enforcedAt.length > 0, `${g.key} missing enforcement points`);
    assert.ok(g.evals.length > 0, `${g.key} missing evals`);
    assert.ok(["low", "medium", "high", "critical"].includes(g.severity), `${g.key} severity`);
  }
});

test("instrumented keys exist in the catalog", () => {
  // Keys used by recordGuardrailEvent call sites across the codebase.
  for (const key of [
    "recipient-allowlist",
    "send-rate-cap",
    "call-rate-cap",
    "webhook-signature",
    "trusted-vendor-sender",
    "sensitive-topic-gate",
    "inbound-injection-fence",
  ]) {
    assert.ok(getGuardrail(key), `catalog missing instrumented key ${key}`);
  }
});
