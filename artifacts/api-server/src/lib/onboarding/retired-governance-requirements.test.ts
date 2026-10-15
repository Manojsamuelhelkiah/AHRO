import { test } from "node:test";
import assert from "node:assert/strict";
import { GOVERNANCE_DECISIONS, isRetiredGovernanceDecision } from "./governance-catalog";
import {
  adoptGovernanceDecisionSnapshot, assessGovernanceCaseImpact,
  evaluateGovernanceExecutionGate, GOVERNANCE_DECISION_RUNTIME_CATALOG,
} from "./governance-runtime";

const retired = [
  { key: "GD-10", revision: 1, status: "provisional" as const,
    domain: "privacy" as const, impactedWorkflows: ["candidate-communications"] },
  { key: "GD-11", revision: 1, status: "rejected" as const,
    domain: "safety" as const, impactedWorkflows: ["*"] },
];

test("retired requirements cannot return through seeding or the runtime catalog", () => {
  for (const { key } of retired) {
    assert.equal(isRetiredGovernanceDecision(key), true);
    assert.equal(GOVERNANCE_DECISIONS.some(row => row.id === key), false);
    assert.equal(GOVERNANCE_DECISION_RUNTIME_CATALOG[key], undefined);
  }
});

test("historical unapproved or rejected retired requirements no longer block analysis", () => {
  assert.equal(evaluateGovernanceExecutionGate({
    workflow: "candidate-communications", execution: { kind: "live" }, decisions: retired,
  }).allowed, true);
  const snapshot = adoptGovernanceDecisionSnapshot({ decisions: retired, adoptedAt: "2026-10-15T00:00:00Z" });
  assert.deepEqual(assessGovernanceCaseImpact({ snapshot, currentDecisions: [] }), []);
  assert.deepEqual(assessGovernanceCaseImpact({
    snapshot: adoptGovernanceDecisionSnapshot({ decisions: [], adoptedAt: "2026-10-15T00:00:00Z" }),
    currentDecisions: retired,
  }), []);
});

test("independent provider denial, other policies and source-evidence protections stay enforced", () => {
  const input = { workflow: "candidate-communications", execution: { kind: "live" as const }, decisions: retired };
  assert.equal(evaluateGovernanceExecutionGate({ ...input, providerDispatchDenied: true }).allowed, false);
  assert.equal(evaluateGovernanceExecutionGate({
    ...input, safeguards: [{ key: "openai", impactedWorkflows: ["candidate-communications"], providerConfigured: false }],
  }).allowed, false);
  assert.equal(evaluateGovernanceExecutionGate({
    ...input, decisions: [{ key: "client-ai-disclosure", revision: 1, status: "provisional",
      domain: "privacy", impactedWorkflows: ["candidate-communications"] }],
  }).allowed, false);
  assert.equal(evaluateGovernanceExecutionGate({
    ...input, workflow: "it-identity-access",
    standardHireAccess: { standardNewHire: true, bgvClear: false, hrisActive: false },
  }).allowed, false);
});
