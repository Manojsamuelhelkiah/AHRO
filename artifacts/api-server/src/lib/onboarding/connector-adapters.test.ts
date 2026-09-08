import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BANK_CHANGE_APPROVAL_RULE,
  PRIVILEGED_ACCESS_APPROVAL_RULE,
  hashApprovalProposal,
  type ApprovalDecision,
  type ApprovalProposal,
  type ApprovalRule,
  type ActionDisposition,
  type PlanBranch,
} from "./compound-action-contract";
import {
  ConnectorDispatchRejectedError,
  dispatchConnectorMutation,
  type ConnectorMutation,
} from "./connector-adapters";

const NOW = new Date("2026-09-08T00:00:00Z");
const ACTORS = {
  requestor: "requestor-1",
  beneficiary: "worker-1",
  executor: "connector-worker-1",
};

function proposal(input: {
  rule: ApprovalRule;
  mutation: ConnectorMutation;
  branch: PlanBranch;
}): ApprovalProposal {
  return {
    tenantId: "tenant-1",
    caseId: "case-1",
    planVersion: 4,
    actionId: "action-1",
    actionBranch: input.branch,
    requiredBranchSet: [input.branch],
    logicalOperationKey: "tenant-1:worker-1:operation",
    toolName: `${input.mutation.connector}.${input.mutation.operation}`,
    canonicalArguments: input.mutation.payload,
    policyVersion: "policy-8",
    evidenceRefs: ["evidence-1"],
    requiredApprovalRule: input.rule,
  };
}

function decisions(
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

async function expectRejectedWithoutWrite(input: {
  mutation: ConnectorMutation;
  proposal: ApprovalProposal;
  decisions?: ApprovalDecision[];
  bindingHash?: string;
  disposition?: ActionDisposition;
  deniedBlockers?: string[];
  actorIds?: typeof ACTORS;
  reason: string;
}) {
  let writes = 0;
  await assert.rejects(
    dispatchConnectorMutation({
      mutation: input.mutation,
      context: {
        proposal: input.proposal,
        binding: {
          proposalHash:
            input.bindingHash ?? hashApprovalProposal(input.proposal),
          disposition: input.disposition,
        },
        decisions: input.decisions ?? [],
        actorIds: input.actorIds ?? ACTORS,
        deniedBlockers: input.deniedBlockers ?? [],
        now: NOW,
      },
      write: async () => {
        writes += 1;
      },
    }),
    (error) =>
      error instanceof ConnectorDispatchRejectedError &&
      error.reason === input.reason,
  );
  assert.equal(writes, 0, "rejected gate must not invoke the network writer");
}

const ORDINARY_MUTATIONS: Array<{
  mutation: ConnectorMutation;
  branch: PlanBranch;
}> = [
  {
    mutation: {
      connector: "payroll",
      operation: "enrol-worker",
      payload: { worker: "worker-1" },
    },
    branch: "payroll-benefits",
  },
  {
    mutation: {
      connector: "iam",
      operation: "provision-account",
      payload: { worker: "worker-1" },
    },
    branch: "it-identity-access",
  },
  {
    mutation: {
      connector: "background-verification",
      operation: "open-check",
      payload: { worker: "worker-1" },
    },
    branch: "background-verification",
  },
  {
    mutation: {
      connector: "documents",
      operation: "send-envelope",
      payload: { worker: "worker-1" },
    },
    branch: "worker-record-documents",
  },
];

describe("mutating connector approval and applicability gate", () => {
  test("every connector rejects an unbound proposal before writing", async () => {
    for (const item of ORDINARY_MUTATIONS) {
      await expectRejectedWithoutWrite({
        mutation: item.mutation,
        proposal: proposal({ ...item, rule: { allOf: [] } }),
        bindingHash: "hash-from-a-different-proposal",
        reason: "unbound_proposal",
      });
    }
  });

  test("every connector rejects an action outside the hash-bound branch set", async () => {
    for (const item of ORDINARY_MUTATIONS) {
      const p = proposal({ ...item, rule: { allOf: [] } });
      p.requiredBranchSet = [];
      await expectRejectedWithoutWrite({
        mutation: item.mutation,
        proposal: p,
        reason: "action_not_required",
      });
    }
  });

  test("changed provider payload is rejected before writing", async () => {
    const item = ORDINARY_MUTATIONS[3];
    const p = proposal({ ...item, rule: { allOf: [] } });
    await expectRejectedWithoutWrite({
      mutation: {
        ...item.mutation,
        payload: { worker: "different-worker" },
      },
      proposal: p,
      reason: "proposal_mismatch",
    });
  });

  test("bank changes require separate fraud-control and payroll authorities", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const p = proposal({
      mutation,
      branch: "payroll-benefits",
      rule: BANK_CHANGE_APPROVAL_RULE,
    });
    await expectRejectedWithoutWrite({
      mutation,
      proposal: p,
      decisions: decisions(p, [["payroll approver", "payroll-1"]]),
      reason: "missing_authority",
    });
  });

  test("privileged access requires manager, owner, and security authorities", async () => {
    const mutation: ConnectorMutation = {
      connector: "iam",
      operation: "privileged-access",
      payload: { role: "administrator" },
    };
    const p = proposal({
      mutation,
      branch: "it-identity-access",
      rule: PRIVILEGED_ACCESS_APPROVAL_RULE,
    });
    await expectRejectedWithoutWrite({
      mutation,
      proposal: p,
      decisions: decisions(p, [
        ["manager", "manager-1"],
        ["application owner", "owner-1"],
      ]),
      reason: "missing_authority",
    });
  });

  test("under-declared privileged and bank policies are rejected", async () => {
    const cases: Array<{ mutation: ConnectorMutation; branch: PlanBranch }> = [
      {
        mutation: {
          connector: "payroll",
          operation: "bank-change",
          payload: { accountToken: "vault-ref" },
        },
        branch: "payroll-benefits",
      },
      {
        mutation: {
          connector: "iam",
          operation: "privileged-access",
          payload: { role: "administrator" },
        },
        branch: "it-identity-access",
      },
    ];
    for (const item of cases) {
      await expectRejectedWithoutWrite({
        mutation: item.mutation,
        proposal: proposal({ ...item, rule: { allOf: [] } }),
        reason: "under_approved_operation",
      });
    }
  });

  test("named-person SoD and nonwaivable denials prevent writes", async () => {
    const mutation: ConnectorMutation = {
      connector: "iam",
      operation: "privileged-access",
      payload: { role: "administrator" },
    };
    const p = proposal({
      mutation,
      branch: "it-identity-access",
      rule: PRIVILEGED_ACCESS_APPROVAL_RULE,
    });
    await expectRejectedWithoutWrite({
      mutation,
      proposal: p,
      decisions: decisions(p, [
        ["manager", "manager-1"],
        ["application owner", "owner-1"],
        ["security approver", "worker-1"],
      ]),
      reason: "separation_of_duties_conflict",
    });
    await expectRejectedWithoutWrite({
      mutation,
      proposal: p,
      decisions: decisions(p, [
        ["manager", "manager-1"],
        ["application owner", "owner-1"],
        ["security approver", "security-1"],
      ]),
      deniedBlockers: ["segregation_of_duties_conflict"],
      reason: "nonwaivable_denial",
    });
  });

  test("expired, rejected, and mismatched decisions all prevent writes", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const p = proposal({
      mutation,
      branch: "payroll-benefits",
      rule: BANK_CHANGE_APPROVAL_RULE,
    });
    const valid = decisions(p, [
      ["fraud-control approver", "fraud-1"],
      ["payroll approver", "payroll-1"],
    ]);
    for (const [changedDecision, reason] of [
      [{ ...valid[0], expiresAt: NOW }, "expired_approval"],
      [{ ...valid[0], decision: "rejected" as const }, "rejected"],
      [{ ...valid[0], proposalHash: "other-hash" }, "proposal_mismatch"],
    ] as const) {
      await expectRejectedWithoutWrite({
        mutation,
        proposal: p,
        decisions: [changedDecision, valid[1]],
        reason,
      });
    }
  });

  test("duplicate approvers and every terminal disposition prevent writes", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const p = proposal({
      mutation,
      branch: "payroll-benefits",
      rule: BANK_CHANGE_APPROVAL_RULE,
    });
    await expectRejectedWithoutWrite({
      mutation,
      proposal: p,
      decisions: decisions(p, [
        ["fraud-control approver", "same-person"],
        ["payroll approver", "same-person"],
      ]),
      reason: "separation_of_duties_conflict",
    });
    for (const disposition of [
      "confirmed",
      "waived",
      "not_applicable",
      "unknown_external_effect",
      "failed",
    ] as const) {
      await expectRejectedWithoutWrite({
        mutation,
        proposal: p,
        decisions: decisions(p, [
          ["fraud-control approver", "fraud-1"],
          ["payroll approver", "payroll-1"],
        ]),
        disposition,
        reason: "action_not_executable",
      });
    }
  });

  test("unsupported operation relabeling fails closed before writing", async () => {
    const item = ORDINARY_MUTATIONS[0];
    const p = proposal({ ...item, rule: { allOf: [] } });
    await expectRejectedWithoutWrite({
      mutation: {
        connector: "payroll",
        operation: "bank-update" as never,
        payload: item.mutation.payload,
      },
      proposal: p,
      reason: "unsupported_operation",
    });
  });

  test("a fully bound and approved operation passes its exact payload once", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const p = proposal({
      mutation,
      branch: "payroll-benefits",
      rule: BANK_CHANGE_APPROVAL_RULE,
    });
    const seen: ConnectorMutation[] = [];
    const result = await dispatchConnectorMutation({
      mutation,
      context: {
        proposal: p,
        binding: { proposalHash: hashApprovalProposal(p) },
        decisions: decisions(p, [
          ["fraud-control approver", "fraud-1"],
          ["payroll approver", "payroll-1"],
        ]),
        actorIds: ACTORS,
        deniedBlockers: [],
        now: NOW,
      },
      write: async (boundMutation) => {
        seen.push(boundMutation as ConnectorMutation);
        return "written";
      },
    });
    assert.equal(result, "written");
    assert.deepEqual(seen, [mutation]);
  });

  test("the approved provider payload is deeply immutable", async () => {
    const mutation: ConnectorMutation = {
      connector: "documents",
      operation: "send-envelope",
      payload: {
        worker: "worker-1",
        fields: [{ name: "legalName", value: "Approved Name" }],
      },
    };
    const p = proposal({
      mutation,
      branch: "worker-record-documents",
      rule: { allOf: [] },
    });
    await dispatchConnectorMutation({
      mutation,
      context: {
        proposal: p,
        binding: { proposalHash: hashApprovalProposal(p) },
        decisions: [],
        actorIds: ACTORS,
        deniedBlockers: [],
        now: NOW,
      },
      write: async (boundMutation) => {
        const payload = boundMutation.payload as {
          fields: Array<{ value: string }>;
        };
        assert.throws(() => {
          payload.fields[0].value = "Changed After Approval";
        }, TypeError);
        assert.equal(payload.fields[0].value, "Approved Name");
      },
    });
  });
});
