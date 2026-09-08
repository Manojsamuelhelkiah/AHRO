import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTION_DISPOSITIONS,
  BANK_CHANGE_APPROVAL_RULE,
  PRIVILEGED_ACCESS_APPROVAL_RULE,
  canClaimDispatch,
  decideDispatchRecovery,
  decideReplan,
  deriveRequiredBranches,
  evaluateApproval,
  hashApprovalProposal,
  preserveDisposition,
  type ApprovalDecision,
  type ApprovalProposal,
  type ApprovalRule,
} from "./compound-action-contract";

function proposal(rule: ApprovalRule): ApprovalProposal {
  return {
    tenantId: "tenant-1",
    caseId: "case-1",
    planVersion: 3,
    actionId: "payroll-benefits",
    logicalOperationKey: "tenant-1:worker-1:payroll:bank-hash",
    toolName: "update-bank",
    canonicalArguments: { accountToken: "vault-ref", routing: "001" },
    policyVersion: "policy-7",
    evidenceRefs: ["bank-verification-9"],
    requiredApprovalRule: rule,
  };
}

function approvals(
  p: ApprovalProposal,
  roles: Array<[string, string]>,
): ApprovalDecision[] {
  return roles.map(([authorityRole, authorityId]) => ({
    proposalHash: hashApprovalProposal(p),
    authorityId,
    authorityRole,
    decision: "approved",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  }));
}

describe("external effect recovery and fencing", () => {
  test("timeout after write retries only with the same provider idempotency key", () => {
    assert.equal(
      decideDispatchRecovery({
        providerIdempotency: true,
        dispatchMayHaveStarted: true,
        reconciliation: "unknown",
      }),
      "retry_same_logical_key",
    );
  });

  test("timeout after write without provider idempotency stops for manual repair", () => {
    assert.equal(
      decideDispatchRecovery({
        providerIdempotency: false,
        dispatchMayHaveStarted: true,
        reconciliation: "negative_not_definitive",
      }),
      "unknown_external_effect_manual_repair",
    );
  });

  test("definitive nonexecution permits redispatch without provider idempotency", () => {
    assert.equal(
      decideDispatchRecovery({
        providerIdempotency: false,
        dispatchMayHaveStarted: true,
        reconciliation: "definitive_nonexecution",
      }),
      "redispatch_same_logical_key",
    );
  });

  test("a stale dispatcher cannot claim the remote write", () => {
    assert.equal(
      canClaimDispatch({
        claimantFencingToken: 8,
        currentFencingToken: 9,
        claimAvailable: true,
      }),
      false,
    );
  });
});

describe("approval authority and binding", () => {
  test("bank changes require separate fraud-control and payroll authorities", () => {
    const p = proposal(BANK_CHANGE_APPROVAL_RULE);
    assert.deepEqual(
      evaluateApproval({
        proposal: p,
        decisions: approvals(p, [["payroll approver", "payroll-1"]]),
        actorIds: { requestor: "requestor-1", executor: "executor-1" },
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: false, reason: "missing_authority" },
    );
    assert.deepEqual(
      evaluateApproval({
        proposal: p,
        decisions: approvals(p, [
          ["fraud-control approver", "fraud-1"],
          ["payroll approver", "payroll-1"],
        ]),
        actorIds: { requestor: "requestor-1", executor: "executor-1" },
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: true },
    );
  });

  test("privileged access requires manager, application owner, and security", () => {
    const p = proposal(PRIVILEGED_ACCESS_APPROVAL_RULE);
    assert.deepEqual(
      evaluateApproval({
        proposal: p,
        decisions: approvals(p, [
          ["manager", "manager-1"],
          ["application owner", "owner-1"],
        ]),
        actorIds: { beneficiary: "worker-1", executor: "executor-1" },
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: false, reason: "missing_authority" },
    );
  });

  test("changed arguments invalidate a previously bound approval", () => {
    const original = proposal(BANK_CHANGE_APPROVAL_RULE);
    const changed = {
      ...original,
      canonicalArguments: { accountToken: "different-vault-ref", routing: "001" },
    };
    assert.deepEqual(
      evaluateApproval({
        proposal: changed,
        decisions: approvals(original, [
          ["fraud-control approver", "fraud-1"],
          ["payroll approver", "payroll-1"],
        ]),
        actorIds: {},
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: false, reason: "proposal_mismatch" },
    );
  });

  test("named-person SoD conflicts and nonwaivable blockers are rejected", () => {
    const p = proposal(PRIVILEGED_ACCESS_APPROVAL_RULE);
    const decisions = approvals(p, [
      ["manager", "manager-1"],
      ["application owner", "owner-1"],
      ["security approver", "worker-1"],
    ]);
    assert.deepEqual(
      evaluateApproval({
        proposal: p,
        decisions,
        actorIds: { beneficiary: "worker-1", executor: "executor-1" },
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: false, reason: "separation_of_duties_conflict" },
    );
    assert.deepEqual(
      evaluateApproval({
        proposal: p,
        decisions: [],
        actorIds: {},
        deniedBlockers: ["segregation_of_duties_conflict"],
        now: new Date("2026-09-08T00:00:00Z"),
      }),
      { allowed: false, reason: "nonwaivable_denial" },
    );
  });
});

describe("planning, replanning, and dispositions", () => {
  test("contractor access and learning are closed over a non-HRIS identity", () => {
    const result = deriveRequiredBranches({
      workerType: "contractor",
      requiresBgv: false,
      requiresPayroll: false,
      requiresAccess: true,
      requiresAssets: false,
      requiresLearning: true,
      subjectSource: "authorized-contractor-registry",
    });
    assert.deepEqual(result, {
      accepted: true,
      branches: ["it-identity-access", "learning-induction"],
    });
  });

  test("unrelated replanning reuses an unchanged confirmed effect", () => {
    assert.equal(
      decideReplan({
        priorDisposition: "confirmed",
        logicalOperationKeyUnchanged: true,
      }),
      "reuse_confirmed_effect",
    );
  });

  test("all terminal dispositions remain distinct", () => {
    assert.equal(new Set(ACTION_DISPOSITIONS).size, 5);
    assert.deepEqual(ACTION_DISPOSITIONS.map(preserveDisposition), [
      "confirmed",
      "waived",
      "not_applicable",
      "unknown_external_effect",
      "failed",
    ]);
  });
});