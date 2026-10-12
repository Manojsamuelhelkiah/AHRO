import { db, onbCases } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  evaluateStoredCaseGovernanceGate,
  type GovernanceExecutionGate,
} from "./governance-runtime";
import { externalProviderDispatchDenied } from "./provider-policy";
import { isRetiredControllerCase } from "./controller-retirement";
import {
  withGovernanceDispatch,
  type GovernanceDispatchResult,
} from "./governance-dispatch";
import {
  evaluateSensitiveLifecycleGate,
  jurisdictionForWorkforceContext,
  withSensitiveLifecycleFence,
  SENSITIVE_DATA_CLASSES,
  type SensitiveDataClass,
} from "./sensitive-lifecycle";
import { getUatCaseIsolation } from "./uat-isolation";
import { candidateEmailDeliveryDecision } from "./channel-routing";
import { sampleCandidateEmailEligible } from "./synthetic-offline";
import { withHroCaseContext, recordHroContextStep } from "../hro-context/manager";

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
  | "workforceContext"
  | "workforceContextVersion"
  | "processPolicySnapshot"
> & { scenarioKey?: string | null };

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

const SENSITIVE_CLASS_BY_WORKFLOW: Readonly<Record<ProviderGovernanceWorkflow, SensitiveDataClass>> = {
  "candidate-communications": "candidate-contact",
  "candidate-voice": "candidate-voice",
  "candidate-portal": "candidate-portal",
  "worker-record-documents": "candidate-document",
};

/**
 * Evaluate current tenant governance at an actual provider or sensitive
 * processing boundary. This intentionally does not inspect the case's
 * historical policy snapshot as a fallback: a missing/legacy snapshot cannot
 * make a newly attempted effect permissible.
 */
export async function evaluateProviderGovernanceGate(
  caseRow: ProviderGovernanceCase,
  workflow: ProviderGovernanceWorkflow,
  options: {
    candidateEmailDelivery?: boolean;
    candidatePortalEmail?: boolean;
    allowIsolatedLocalOperation?: "candidate-private-upload" | "candidate-portal-credential";
  } = {},
): Promise<ProviderGovernanceGate> {
  const gate = await evaluateStoredCaseGovernanceGate({
    caseRow,
    // Both modules use the same explicit canonical scope union. No `as never`
    // escape hatch may hide an unmapped real-provider workflow.
    workflow,
    candidateEmailDelivery: sampleCandidateEmailEligible(caseRow) && (
      options.candidateEmailDelivery && workflow === PROVIDER_GOVERNANCE_WORKFLOW.communication ||
      options.candidatePortalEmail && workflow === PROVIDER_GOVERNANCE_WORKFLOW.portal
    ),
  });
  const [current] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, caseRow.organizationId), eq(onbCases.id, caseRow.id),
  )).limit(1);
  if (current && isRetiredControllerCase(current)) {
    return { allowed: false, workflow, gate, reason: "Historical controller case: all operational effects are retired." };
  }
  if (gate.execution === "isolated-simulation" &&
    !options.allowIsolatedLocalOperation) {
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
  /** Stable provider identifier matched against the approved policy allowlist. */
  providerId: string;
  /** Fixed Gmail candidate path, never administrative mail or other effects. */
  candidateEmailDelivery?: boolean;
  /** Internal bearer-link issuance accompanying an explicitly requested email. */
  candidatePortalEmail?: boolean;
  /** Server-derived data class for document-specific provider disclosures. */
  dataClass?: SensitiveDataClass;
  /**
   * Only server-owned fixed projections may opt out of opaque-message
   * classification. Caller labels, persisted channel values, and client text
   * are not evidence that a payload is minimal.
   */
  minimalTypedPayload?: boolean;
   /** Only narrowly authorized communication/voice Demo paths may opt in. */
   /**
    * Local non-provider operations available to a durably linked UAT case.
    * This is deliberately an enum rather than a caller-controlled boolean.
    */
   allowIsolatedLocalOperation?: "candidate-private-upload" | "candidate-portal-credential";
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
    // This is intentionally inside the durable provider dispatch fence. A
    // route-level preflight cannot authorize a later external disclosure.
    return withSensitiveLifecycleFence(input.caseRow.organizationId, async () => {
      // The caller may have loaded this record before a workforce correction
      // or an upload-reservation context bind. Take a short current-row lock
      // after the lifecycle fence, then release it before arbitrary provider
      // callbacks. The lifecycle fence remains held through I/O, so compliant
      // context writers cannot replace the jurisdiction between this final
      // read and dispatch, while a callback cannot self-deadlock by opening
      // its own case/authority transaction.
      const currentCase = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(onbCases).where(and(
          eq(onbCases.organizationId, input.caseRow.organizationId),
          eq(onbCases.id, input.caseRow.id),
        )).for("update");
        return row ?? null;
      });
      if (!currentCase) {
        deniedReason = "The onboarding case no longer exists in this organization.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      if (isRetiredControllerCase(currentCase)) {
        deniedReason = "This case is retained historical evidence; operational effects are retired.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      if (
        input.caseRow.workforceContextVersion === null ||
        input.caseRow.workforceContextVersion === undefined ||
        currentCase.workforceContextVersion !== input.caseRow.workforceContextVersion
      ) {
        deniedReason = "The case workforce context changed after this provider payload was composed; rebuild it from the current approved context.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      const unresolvedContextHold = currentCase.checklistSnapshot.some((item) =>
        item.enabled && item.mandatory &&
        (item.id === "policy-rebase-required" || item.id === "workforce-context-review") &&
        currentCase.readiness.find((readiness) => readiness.key === item.id)?.status !== "ready",
      );
      if (unresolvedContextHold) {
        deniedReason = "The case has a pending workforce policy rebase or migration review hold; rebuild and explicitly release it before provider dispatch.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      const uatIsolation = await getUatCaseIsolation(currentCase);
      const candidateEmailDelivery = input.candidateEmailDelivery === true &&
        input.workflow === PROVIDER_GOVERNANCE_WORKFLOW.communication &&
        input.providerId === "gmail" && sampleCandidateEmailEligible(currentCase) &&
        !uatIsolation.linkedToRun;
      const candidatePortalEmail = input.candidatePortalEmail === true &&
        input.workflow === PROVIDER_GOVERNANCE_WORKFLOW.portal &&
        input.providerId === "internal-candidate-portal" && sampleCandidateEmailEligible(currentCase) &&
        !uatIsolation.linkedToRun;
      if ((input.candidateEmailDelivery || input.candidatePortalEmail) && (
        !(candidateEmailDelivery || candidatePortalEmail) ||
        candidateEmailDeliveryDecision(currentCase).address !== candidateEmailDeliveryDecision(input.caseRow).address
      )) {
        deniedReason = "Candidate email is unavailable, isolated, or changed after this payload was composed.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      const localUatOperation =
        input.allowIsolatedLocalOperation === "candidate-private-upload" &&
        input.workflow === PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing &&
        input.providerId === "replit-object-storage" ||
        input.allowIsolatedLocalOperation === "candidate-portal-credential" &&
        input.workflow === PROVIDER_GOVERNANCE_WORKFLOW.portal &&
        input.providerId === "internal-candidate-portal";
      if (uatIsolation.isolated && !candidateEmailDelivery && !candidatePortalEmail && (
        !uatIsolation.fencedByScenarioKey ||
        !uatIsolation.linkedToRun ||
        !localUatOperation
      )) {
        deniedReason = "UAT-isolated cases never dispatch external providers or ordinary effects.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      // This switch is an execution fence for external I/O, not a reason to
      // reject the two explicitly enumerated, tenant/run-owned local UAT
      // operations. `localUatOperation` above has already proved the case,
      // workflow and internal storage/provider identity; it cannot authorize
      // a network provider call.
      if (externalProviderDispatchDenied() && !localUatOperation) {
        deniedReason = "External provider dispatch is denied by the active execution safety policy.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      const gate = await evaluateProviderGovernanceGate(
        currentCase,
        input.workflow,
        {
          allowIsolatedLocalOperation: input.allowIsolatedLocalOperation,
          candidateEmailDelivery,
          candidatePortalEmail,
        },
      );
      if (!gate.allowed) {
        deniedReason = gate.reason ?? "Live provider dispatch is blocked by current governance review.";
        return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
      }
      const channelClass = input.dataClass ?? SENSITIVE_CLASS_BY_WORKFLOW[input.workflow];
      // A workflow name or server-derived routing label does not prove the
      // provider payload is class-minimal. Opaque document bytes (and all
      // other non-proven projections) must satisfy every class policy at the
      // final provider boundary.
      const lifecycleClasses: readonly SensitiveDataClass[] =
        input.minimalTypedPayload ? [channelClass] : SENSITIVE_DATA_CLASSES;
      for (const dataClass of localUatOperation ? [] : lifecycleClasses) {
        const lifecycle = await evaluateSensitiveLifecycleGate({
          organizationId: currentCase.organizationId,
          jurisdiction: jurisdictionForWorkforceContext(currentCase.workforceContext),
          dataClass,
          disclosure: true,
          providerId: input.providerId,
        });
        if (!lifecycle.allowed) {
          deniedReason = lifecycle.reason ?? "Sensitive lifecycle policy blocks external disclosure.";
          return { value: PROVIDER_GOVERNANCE_DENIED, disposition: "definitive-not-sent" as const };
        }
      }
      const dispatched = await withHroCaseContext(currentCase, async () => {
        await recordHroContextStep("provider-boundary", { reference: input.operation });
        return input.dispatch();
      }, input.workflow === PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing ? "documents" : "communications");
      return { value: dispatched, disposition: input.disposition(dispatched) };
    });
  });
  if (value === PROVIDER_GOVERNANCE_DENIED) {
    return {
      dispatched: false,
      reason: deniedReason ?? "Live provider dispatch is blocked by current governance review.",
    };
  }
  return { dispatched: true, value };
}