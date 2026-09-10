import {
  BANK_CHANGE_APPROVAL_RULE,
  PRIVILEGED_ACCESS_APPROVAL_RULE,
  evaluateApplicability,
  evaluateApproval,
  type ApprovalDecision,
  type ApprovalProposal,
  type ApprovalRule,
  type CanonicalValue,
  type ExecutableActionBinding,
  type PlanBranch,
} from "./compound-action-contract";

export type MutatingConnector =
  | "payroll"
  | "iam"
  | "background-verification"
  | "documents";

export type ConnectorMutation =
  | {
      connector: "payroll";
      operation: "bank-change" | "enrol-worker";
      payload: CanonicalValue;
    }
  | {
      connector: "iam";
      operation: "privileged-access" | "provision-account";
      payload: CanonicalValue;
    }
  | {
      connector: "background-verification";
      operation: "open-check";
      payload: CanonicalValue;
    }
  | {
      connector: "documents";
      operation: "send-envelope";
      payload: CanonicalValue;
    };

export class ConnectorDispatchRejectedError extends Error {
  constructor(
    readonly connector: MutatingConnector,
    readonly reason: string,
  ) {
    super(`${connector} connector dispatch rejected: ${reason}`);
    this.name = "ConnectorDispatchRejectedError";
  }
}

export type ConnectorDispatchContext = {
  proposal: ApprovalProposal;
  binding: ExecutableActionBinding;
  decisions: ApprovalDecision[];
  actorIds: {
    requestor: string;
    beneficiary: string;
    executor: string;
  };
  deniedBlockers: string[];
  now: Date;
  /** Durable offline fixtures may never reach a connector writer. */
  syntheticOffline?: boolean;
};

export function createConnectorProposal(input: {
  mutation: ConnectorMutation;
  tenantId: string;
  caseId: string;
  planVersion: number;
  requiredBranchSet: PlanBranch[];
  logicalOperationKey: string;
  policyVersion: string;
  evidenceRefs: string[];
}): ApprovalProposal {
  const policy = policyFor(input.mutation);
  return {
    tenantId: input.tenantId,
    caseId: input.caseId,
    planVersion: input.planVersion,
    actionId: `${policy.branch}:${input.mutation.operation}`,
    actionBranch: policy.branch,
    requiredBranchSet: input.requiredBranchSet,
    logicalOperationKey: input.logicalOperationKey,
    toolName: policy.toolName,
    canonicalArguments: input.mutation.payload,
    policyVersion: input.policyVersion,
    evidenceRefs: input.evidenceRefs,
    requiredApprovalRule: policy.rule,
  };
}

type ConnectorPolicy = {
  branch: PlanBranch;
  toolName: string;
  rule: ApprovalRule;
};

const NO_APPROVALS: ApprovalRule = { allOf: [] };

function policyFor(mutation: ConnectorMutation): ConnectorPolicy {
  switch (`${mutation.connector}:${mutation.operation}`) {
    case "payroll:bank-change":
      return {
        branch: "payroll-benefits",
        toolName: "payroll.bank-change",
        rule: BANK_CHANGE_APPROVAL_RULE,
      };
    case "payroll:enrol-worker":
      return {
        branch: "payroll-benefits",
        toolName: "payroll.enrol-worker",
        rule: NO_APPROVALS,
      };
    case "iam:privileged-access":
      return {
        branch: "it-identity-access",
        toolName: "iam.privileged-access",
        rule: PRIVILEGED_ACCESS_APPROVAL_RULE,
      };
    case "iam:provision-account":
      return {
        branch: "it-identity-access",
        toolName: "iam.provision-account",
        rule: NO_APPROVALS,
      };
    case "background-verification:open-check":
      return {
        branch: "background-verification",
        toolName: "background-verification.open-check",
        rule: NO_APPROVALS,
      };
    case "documents:send-envelope":
      return {
        branch: "worker-record-documents",
        toolName: "documents.send-envelope",
        rule: NO_APPROVALS,
      };
    default:
      throw new ConnectorDispatchRejectedError(
        mutation.connector,
        "unsupported_operation",
      );
  }
}

function canonicalize(value: CanonicalValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T extends CanonicalValue>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableMutation(
  mutation: ConnectorMutation,
): Readonly<ConnectorMutation> {
  const payload = JSON.parse(canonicalize(mutation.payload)) as CanonicalValue;
  return Object.freeze({
    ...mutation,
    payload: deepFreeze(payload),
  }) as Readonly<ConnectorMutation>;
}

function sameRule(left: ApprovalRule, right: ApprovalRule): boolean {
  return canonicalize(left as unknown as CanonicalValue) ===
    canonicalize(right as unknown as CanonicalValue);
}

function assertMutationBound(
  mutation: ConnectorMutation,
  proposal: ApprovalProposal,
  policy: ConnectorPolicy,
): void {
  if (
    proposal.toolName !== policy.toolName ||
    canonicalize(proposal.canonicalArguments) !== canonicalize(mutation.payload)
  ) {
    throw new ConnectorDispatchRejectedError(
      mutation.connector,
      "proposal_mismatch",
    );
  }
  if (!sameRule(proposal.requiredApprovalRule, policy.rule)) {
    throw new ConnectorDispatchRejectedError(
      mutation.connector,
      "under_approved_operation",
    );
  }
}

/**
 * Final, fail-closed boundary for payroll, IAM, BGV, and document writes.
 * The exact payload passed to the provider is compared with the hash-bound
 * proposal in the same call stack immediately before the provider is called.
 */
export async function dispatchConnectorMutation<T>(input: {
  mutation: ConnectorMutation;
  context: ConnectorDispatchContext;
  write: (mutation: Readonly<ConnectorMutation>) => Promise<T>;
}): Promise<T> {
  if (input.context.syntheticOffline) {
    throw new ConnectorDispatchRejectedError(
      input.mutation.connector,
      "synthetic_offline_case",
    );
  }
  const mutation = immutableMutation(input.mutation);
  const policy = policyFor(mutation);
  assertMutationBound(mutation, input.context.proposal, policy);

  const applicability = evaluateApplicability({
    proposal: input.context.proposal,
    binding: input.context.binding,
    requiredBranch: policy.branch,
  });
  if (!applicability.allowed) {
    throw new ConnectorDispatchRejectedError(
      input.mutation.connector,
      applicability.reason,
    );
  }

  const approval = evaluateApproval({
    proposal: input.context.proposal,
    decisions: input.context.decisions,
    actorIds: input.context.actorIds,
    deniedBlockers: input.context.deniedBlockers,
    now: input.context.now,
  });
  if (!approval.allowed) {
    throw new ConnectorDispatchRejectedError(
      input.mutation.connector,
      approval.reason,
    );
  }

  return input.write(mutation);
}