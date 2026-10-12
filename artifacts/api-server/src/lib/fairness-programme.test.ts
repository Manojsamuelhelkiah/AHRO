import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFairnessAction, fairnessActionSchema, validateCriteria, validateReviewSet } from "./fairness-programme";
import { FAIRNESS_PAIRS, compareFairnessPair, fairnessDigest } from "./fairness-catalog";
import { minimizeAuditPayload } from "./onboarding/protected-audit";
import { checkHroAiBudget } from "./hro-context/ai-budget";
import { evaluateAgentInvocation } from "./agent-invocation";
import type { PolicyExtractSelection } from "./hr-policy-ai";
import { buildPolicySelectionRequest, POLICY_SELECTION_IDENTITY } from "./hr-policy-ai";

test("developer-only paired fixtures retain equal legitimate facts and complete source context", () => {
  for (const pair of FAIRNESS_PAIRS) {
    assert.equal(pair.variants.length, 2);
    const normalized = pair.variants.map(v => v.question.replace(v.characteristic, ""));
    assert.equal(normalized[0], normalized[1]);
    assert.notEqual(pair.variants[0].characteristic, pair.variants[1].characteristic);
    assert.ok(checkHroAiBudget([{ content: pair.excerpt }, { content: pair.sourceContext }, { content: pair.variants[0].question }], 3000));
  }
  assert.throws(() => checkHroAiBudget([{ content: "x".repeat(30_000) }], 3000));
  assert.equal(POLICY_SELECTION_IDENTITY.promptDigest, fairnessDigest(buildPolicySelectionRequest("{question}", "{excerpt}", "{sourceContext}")));
});
test("historical paired equality never proves correctness or professional review", () => {
  const supported: PolicyExtractSelection = { outcome: "supported", excerptId: "extract-1", quotedText: FAIRNESS_PAIRS[0].excerpt };
  const insufficient: PolicyExtractSelection = { outcome: "insufficient", excerptId: null, quotedText: null };
  assert.equal(compareFairnessPair("supported", [supported, supported]).status, "observed-match");
  assert.equal(compareFairnessPair("supported", [insufficient, insufficient]).status, "investigate");
  assert.equal(compareFairnessPair("supported", [supported, insufficient]).differences.length, 2);
  assert.equal(compareFairnessPair("supported", [supported, null]).status, "blocked");
  assert.equal(compareFairnessPair("supported", []).status, "blocked");
  assert.throws(() => validateCriteria(["pronouns-supported"], []));
  assert.throws(() => validateCriteria(["pronouns-supported"], [{ pairId: "names-supported", expected: "supported", rationale: "Reviewed facts" }]));
  assert.throws(() => validateReviewSet([
    { role: "business", userId: "same", assignmentId: null, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
    { role: "hr-compliance", userId: "same", assignmentId: 1, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
    { role: "legal", userId: "third", assignmentId: 2, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
  ]));
});
test("real-data and invented tool inputs remain rejected and audit digests stay minimized", () => {
  for (const extra of [{ employeeId: 1 }, { protectedCharacteristics: { ethnicity: "real" } }, { selector: "bypass" }, { toolKey: "tool.case.read" }]) {
    assert.equal(fairnessActionSchema.safeParse({ kind: "run", expectedVersion: 0, ...extra }).success, false);
  }
  assert.equal(evaluateAgentInvocation({ trustedOrganizationId: "test", requestedAgentId: "a", registeredAgentId: "a", agentActive: true,
    agentOwnerUserId: "u", initiatingUserId: "u", caseBelongsToTenant: true, toolKey: "tool.fairness.rank", effectiveAccess: ["tool.fairness.rank"] }).allowed, false);
  const digest = fairnessDigest({ fixture: "synthetic" });
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: digest }, "fairness.run"), { evidenceDigest: digest });
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: digest }, "unrelated"), {});
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: "person@example.com" }, "fairness.run"), {});
});
test("all retired programme actions reject before authority grants, reviews, model calls or outcome creation", async () => {
  let calls = 0;
  for (const kind of ["define-scope", "review-scope", "define-criteria", "review-criteria", "run", "stop"]) {
    await assert.rejects(applyFairnessAction("client", "verified-reviewer", { kind, expectedVersion: 0 }, {
      selector: async () => { calls++; throw new Error("Retired model dispatch"); },
    }), { name: "RetiredCaseCapabilityError", status: 410 });
  }
  assert.equal(calls, 0);
});
