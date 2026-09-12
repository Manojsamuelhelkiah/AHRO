import { onbCases } from "@workspace/db/schema";
import {
  evaluateStoredCaseGovernanceGate,
  type GovernanceExecutionGate,
} from "./governance-runtime";
import { externalProviderDispatchDenied } from "./provider-policy";
import {
  withGovernanceDispatch,
  type GovernanceDispatchResult,
} from "./governance-dispatch";

/**
 * Canonical provider-boundary scopes. These are server-owned constants: a
 * route, job, or provider callback must not select a less restrictive scope
 * from request data in order to avoid a legal/privacy/safety decision.
 *
 * The governance runtime owns the decision-to-scope catalog mapping. Keep the
 * values here as the provider adapter contract, rather than teaching each
 * provider implementation how to interpret mutable governance records.
 */
export const PROVIDER_GOVERNANCE_WORKFLOW = {
  communication: "candidate-communications",
  voice: "candidate-voice",
  portal: "candidate-portal",
  // Document verification already has a canonical runtime scope. Do not
  // invent a parallel provider label for the same sensitive processing.
  documentProcessing: "worker-record-documents",
} as const;

export type ProviderGovernanceWorkflow =
  (typeof PROVIDER_GOVERNANCE_WORKFLOW)[keyof typeof PROVIDER_GOVERNANCE_WORKFLOW];

export type ProviderGovernanceCase = Pick<
  typeof onbCases.$inferSelect,
  | "id"
  | "organizationId"
  | "workerName"
  | "workerEmail"
  | "workerPhone"
  | "notes"
  | "hireType"
  | "workerCategory"
  | "processPolicySnapshot"
>;

export type ProviderGovernanceGate = {
  allowed: boolean;
  workflow: ProviderGovernanceWorkflow;
  gate: GovernanceExecutionGate | null;
  reason: string | null;
};

export type ProviderGovernanceDispatch<T> =
  | { dispatched: true; value: T }
  | { dispatched: false; reason: string };
const PROVIDER_GOVERNANCE_DENIED = Symbol("provider-governance-denied");

/**
 * Evaluate current tenant governance at an actual provider or sensitive
 * processing boundary. This intentionally does not inspect the case's
 * historical policy snapshot as a fallback: a missing/legacy snapshot cannot
 * make a newly attempted effect permissible.
 */
export async function evaluateProviderGovernanceGate(
  caseRow: ProviderGovernanceCase,
  workflow: ProviderGovernanceWorkflow,
  options: { allowIsolatedProviderDispatch?: boolean } = {},
): Promise<ProviderGovernanceGate> {
  const gate = await evaluateStoredCaseGovernanceGate({
    caseRow,
    // Both modules use the same explicit canonical scope union. No `as never`
    // escape hatch may hide an unmapped real-provider workflow.
    workflow,
  });
  if (gate.execution === "isolated-simulation" && !options.allowIsolatedProviderDispatch) {
    return {
      allowed: false,
      workflow,
      gate,
      reason: "Source-mode simulated evidence cannot be sent to or accepted from a live provider.",
    };
  }
  if (gate.allowed) {
    return { allowed: true, workflow, gate, reason: null };
  }
  return {
    allowed: false,
    workflow,
    gate,
    reason: `Live ${workflow} is blocked by current governance review: ${
      gate.blockers.map((blocker) => blocker.message).join(" ")
    }`,
  };
}

/**
 * The final provider request runs behind the organization-wide governance
 * fence. Callers still perform the inexpensive pre-claim gate themselves;
 * this second evaluation is intentionally inside the durable dispatch claim
 * so a governance mutation cannot land between a "yes" and provider I/O.
 */
export async function dispatchWithProviderGovernance<T>(input: {
  caseRow: ProviderGovernanceCase;
  workflow: ProviderGovernanceWorkflow;
  operation: string;
  /** Only narrowly authorized communication/voice demo paths may opt in. */
  allowIsolatedProviderDispatch?: boolean;
  dispatch: () => Promise<T>;
  disposition: (value: T) => GovernanceDispatchResult<T>["disposition"];
}): Promise<ProviderGovernanceDispatch<T>> {
  let deniedReason: string | null = null;
  const value = await withGovernanceDispatch<T | typeof PROVIDER_GOVERNANCE_DENIED>({
    organizationId: input.caseRow.organizationId,
    operation: input.operation,
    adoptedCaseSnapshot:
      input.caseRow.processPolicySnapshot &&
        typeof input.caseRow.processPolicySnapshot === "object" &&
        !Array.isArray(input.caseRow.processPolicySnapshot)
        ? input.caseRow.processPolicySnapshot as Record<string, unknown>
        : undefined,
  }, async () => {
    // withGovernanceDispatch committed its marker before this callback. A
    // governance mutation must now observe that marker and fail closed, so
    // this final current-state evaluation cannot race a subsequent provider
    // request. Do not put this evaluator in beforeDispatch: it seeds/reads
    // through the global DB handle and would deadlock on the org advisory lock.
    if (externalProviderDispatchDenied()) {
      deniedReason = "External provider dispatch is denied by the active execution safety policy.";
      return {
        value: PROVIDER_GOVERNANCE_DENIED,
        disposition: "definitive-not-sent",
      };
    }
    const gate = await evaluateProviderGovernanceGate(
      input.caseRow,
      input.workflow,
      { allowIsolatedProviderDispatch: input.allowIsolatedProviderDispatch },
    );
    if (!gate.allowed) {
      deniedReason = gate.reason ?? "Live provider dispatch is blocked by current governance review.";
      return {
        value: PROVIDER_GOVERNANCE_DENIED,
        disposition: "definitive-not-sent",
      };
    }
    const dispatched = await input.dispatch();
    return { value: dispatched, disposition: input.disposition(dispatched) };
  });
  if (value === PROVIDER_GOVERNANCE_DENIED) {
    return {
      dispatched: false,
      reason: deniedReason ?? "Live provider dispatch is blocked by current governance review.",
    };
  }
  return { dispatched: true, value };
}