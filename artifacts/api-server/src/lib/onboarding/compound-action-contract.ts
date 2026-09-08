import { createHash } from "node:crypto";

export const ACTION_DISPOSITIONS = [
  "confirmed",
  "waived",
  "not_applicable",
  "unknown_external_effect",
  "failed",
] as const;

export type ActionDisposition = (typeof ACTION_DISPOSITIONS)[number];
export type ReconciliationResult =
  | "not_attempted"
  | "found_effect"
  | "definitive_nonexecution"
  | "negative_not_definitive"
  | "unknown";

export type DispatchRecoveryDecision =
  | "dispatch"
  | "retry_same_logical_key"
  | "reuse_confirmed_effect"
  | "redispatch_same_logical_key"
  | "unknown_external_effect_manual_repair";

export function decideDispatchRecovery(input: {
  providerIdempotency: boolean;
  dispatchMayHaveStarted: boolean;
  reconciliation: ReconciliationResult;
}): DispatchRecoveryDecision {
  if (!input.dispatchMayHaveStarted) return "dispatch";
  if (input.reconciliation === "found_effect") return "reuse_confirmed_effect";
  if (input.providerIdempotency) return "retry_same_logical_key";
  if (input.reconciliation === "definitive_nonexecution") {
    return "redispatch_same_logical_key";
  }
  return "unknown_external_effect_manual_repair";
}

export function canClaimDispatch(input: {
  claimantFencingToken: number;
  currentFencingToken: number;
  claimAvailable: boolean;
}): boolean {
  return (
    input.claimAvailable &&
    input.claimantFencingToken === input.currentFencingToken
  );
}

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

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

export type ApprovalProposal = {
  tenantId: string;
  caseId: string;
  planVersion: number;
  actionId: string;
  actionBranch: PlanBranch;
  requiredBranchSet: PlanBranch[];
  logicalOperationKey: string;
  toolName: string;
  canonicalArguments: CanonicalValue;
  policyVersion: string;
  evidenceRefs: string[];
  requiredApprovalRule: ApprovalRule;
};

export type ApprovalRule = {
  allOf: string[];
  anyOf?: string[];
  distinctAuthorityRoles?: boolean;
  nonWaivableDenyOn?: string[];
};

export type ApprovalDecision = {
  proposalHash: string;
  authorityId: string;
  authorityRole: string;
  decision: "approved" | "rejected";
  expiresAt: Date;
};

export function hashApprovalProposal(proposal: ApprovalProposal): string {
  return createHash("sha256").update(canonicalize(proposal)).digest("hex");
}

export type ApprovalEvaluation =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "proposal_mismatch"
        | "expired_approval"
        | "rejected"
        | "missing_authority"
        | "separation_of_duties_conflict"
        | "nonwaivable_denial";
    };

export type ApplicabilityEvaluation =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "unbound_proposal"
        | "action_not_required"
        | "action_not_executable";
    };

export type ExecutableActionBinding = {
  proposalHash: string;
  disposition?: ActionDisposition;
};

export function evaluateApplicability(input: {
  proposal: ApprovalProposal;
  binding: ExecutableActionBinding;
  requiredBranch: PlanBranch;
}): ApplicabilityEvaluation {
  if (input.binding.proposalHash !== hashApprovalProposal(input.proposal)) {
    return { allowed: false, reason: "unbound_proposal" };
  }
  if (
    input.proposal.actionBranch !== input.requiredBranch ||
    !input.proposal.requiredBranchSet.includes(input.requiredBranch)
  ) {
    return { allowed: false, reason: "action_not_required" };
  }
  if (input.binding.disposition !== undefined) {
    return { allowed: false, reason: "action_not_executable" };
  }
  return { allowed: true };
}

export function evaluateApproval(input: {
  proposal: ApprovalProposal;
  decisions: ApprovalDecision[];
  actorIds: {
    requestor?: string;
    beneficiary?: string;
    executor?: string;
  };
  deniedBlockers?: string[];
  now: Date;
}): ApprovalEvaluation {
  const rule = input.proposal.requiredApprovalRule;
  if (
    input.deniedBlockers?.some((blocker) =>
      rule.nonWaivableDenyOn?.includes(blocker),
    )
  ) {
    return { allowed: false, reason: "nonwaivable_denial" };
  }

  const expectedHash = hashApprovalProposal(input.proposal);
  if (input.decisions.some((decision) => decision.proposalHash !== expectedHash)) {
    return { allowed: false, reason: "proposal_mismatch" };
  }
  if (input.decisions.some((decision) => decision.expiresAt <= input.now)) {
    return { allowed: false, reason: "expired_approval" };
  }
  if (input.decisions.some((decision) => decision.decision === "rejected")) {
    return { allowed: false, reason: "rejected" };
  }

  const approved = input.decisions.filter(
    (decision) => decision.decision === "approved",
  );
  const byRole = new Map(
    approved.map((decision) => [decision.authorityRole, decision]),
  );
  if (rule.allOf.some((role) => !byRole.has(role))) {
    return { allowed: false, reason: "missing_authority" };
  }
  if (
    rule.anyOf?.length &&
    !rule.anyOf.some((role) => byRole.has(role))
  ) {
    return { allowed: false, reason: "missing_authority" };
  }

  const authorityIds = approved.map((decision) => decision.authorityId);
  const protectedActors = Object.values(input.actorIds).filter(
    (id): id is string => Boolean(id),
  );
  if (
    authorityIds.some((id) => protectedActors.includes(id)) ||
    (rule.distinctAuthorityRoles !== false &&
      new Set(authorityIds).size !== authorityIds.length)
  ) {
    return { allowed: false, reason: "separation_of_duties_conflict" };
  }
  return { allowed: true };
}

export const BANK_CHANGE_APPROVAL_RULE: ApprovalRule = {
  allOf: ["fraud-control approver", "payroll approver"],
  distinctAuthorityRoles: true,
  nonWaivableDenyOn: [
    "identity_mismatch",
    "missing_mandatory_payroll_identity",
  ],
};

export const PRIVILEGED_ACCESS_APPROVAL_RULE: ApprovalRule = {
  allOf: ["manager", "application owner", "security approver"],
  distinctAuthorityRoles: true,
  nonWaivableDenyOn: ["segregation_of_duties_conflict"],
};

export type PlanBranch =
  | "worker-record-documents"
  | "background-verification"
  | "payroll-benefits"
  | "it-identity-access"
  | "assets-workplace"
  | "learning-induction";

export function deriveRequiredBranches(input: {
  workerType: "employee" | "intern" | "contractor" | "vendor";
  paidIntern?: boolean;
  requiresBgv: boolean;
  requiresPayroll: boolean;
  requiresAccess: boolean;
  requiresAssets: boolean;
  requiresLearning: boolean;
  subjectSource: "HRIS" | "authorized-contractor-registry" | "authorized-vendor-registry";
}): { accepted: true; branches: PlanBranch[] } | { accepted: false; reason: string } {
  const branches = new Set<PlanBranch>();
  // Every worker type needs a bound worker/document record, even when the
  // non-employee pathway excludes payroll.
  branches.add("worker-record-documents");
  if (input.requiresBgv) branches.add("background-verification");
  if (input.requiresPayroll) branches.add("payroll-benefits");
  if (input.requiresAccess) branches.add("it-identity-access");
  if (input.requiresAssets) branches.add("assets-workplace");
  if (input.requiresLearning) branches.add("learning-induction");

  if (input.requiresPayroll && !branches.has("worker-record-documents")) {
    return { accepted: false, reason: "payroll requires worker record" };
  }
  const nonEmployee =
    input.workerType === "contractor" || input.workerType === "vendor";
  if (
    nonEmployee &&
    (input.requiresAccess || input.requiresLearning) &&
    input.subjectSource === "HRIS"
  ) {
    return {
      accepted: false,
      reason: "nonemployee access and learning require an authorized registry identity",
    };
  }
  return { accepted: true, branches: [...branches] };
}

export function decideReplan(input: {
  priorDisposition: ActionDisposition;
  logicalOperationKeyUnchanged: boolean;
}): "reuse_confirmed_effect" | "execute_new_logical_operation" {
  return input.priorDisposition === "confirmed" &&
    input.logicalOperationKeyUnchanged
    ? "reuse_confirmed_effect"
    : "execute_new_logical_operation";
}

export function preserveDisposition(
  disposition: ActionDisposition,
): ActionDisposition {
  if (!ACTION_DISPOSITIONS.includes(disposition)) {
    throw new Error(`Unsupported action disposition: ${String(disposition)}`);
  }
  return disposition;
}