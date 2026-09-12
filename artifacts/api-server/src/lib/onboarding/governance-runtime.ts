import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  db,
  onbCases,
  onbConnectors,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisions,
  onbGovernanceDecisionReviews,
  onbGovernanceRequirements,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbSystemChecks,
} from "@workspace/db";
import { ensureGovernanceSeeded } from "./governance";
import {
  acquireCaseDispatchMutationLock,
  hasActiveCaseDispatchMarker,
} from "./dispatch-guard";
import { reopenGateCApprovalInTransaction } from "./readiness-sla-policy";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { assertGovernanceMutationAllowed } from "./governance-dispatch";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";
import {
  hasTrustedBgvClearanceEvidence,
  hasTrustedHrisActivationEvidence,
  hasTrustedProviderConfiguration,
} from "./connector-evidence-provenance";

/**
 * Runtime-only governance rules.
 *
 * The decision register owns persistence, authority verification, and revision
 * history.  This module deliberately owns neither: callers supply the
 * server-loaded current revisions and activation facts immediately before an
 * effect.  Keeping the evaluation deterministic makes it usable at every
 * provider boundary without treating a browser supplied "simulation" flag as
 * authority.
 */

export const GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION =
  "governance-case-snapshot/v1" as const;

export type GovernanceDecisionStatus =
  | "draft"
  | "provisional"
  | "approved"
  | "rejected"
  | "superseded";

export type GovernanceDecisionDomain = "legal" | "privacy" | "safety";

export type GovernanceDecisionRuntimeRevision = {
  key: string;
  revision: number;
  status: GovernanceDecisionStatus;
  /**
   * Only these sensitive, explicitly marked decisions gate live execution.
   * Other provisional planning decisions remain visible review work, rather
   * than becoming an accidental global connector deny-list.
   */
  domain: GovernanceDecisionDomain;
  impactedWorkflows: readonly string[];
  title?: string;
  /** Rechecked against an unrevoked, unexpired verified assignment at dispatch. */
  reviewerAuthorityActive?: boolean;
};

export type GovernanceRequirementCoverage = {
  implemented: boolean;
  tested: boolean;
  configured: boolean;
  approvedForLive: boolean;
};

export type GovernanceRequirementRuntimeState = {
  key: string;
  impactedWorkflows: readonly string[];
  coverage: GovernanceRequirementCoverage;
  /** A provider being selected or named is not proof it is configured. */
  providerConfigured?: boolean;
  /** Evidence is a distinct source-recorded fact, never inferred from config. */
  realEvidenceAvailable?: boolean;
};

export type GovernanceExecutionContext =
  | { kind: "live" }
  | { kind: "isolated-simulation" };

export type GovernanceGateBlocker = {
  kind:
    | "unapproved-sensitive-decision"
    | "reviewer-authority-inactive"
    | "case-governance-snapshot-missing"
    | "requirement-not-approved-for-live"
    | "requirement-not-configured"
    | "provider-not-configured"
    | "evidence-not-available"
    | "provider-policy-denied"
    | "bgv-not-clear"
    | "hris-not-active";
  key: string;
  message: string;
};

export type GovernanceExecutionGate = {
  allowed: boolean;
  execution: GovernanceExecutionContext["kind"];
  blockers: GovernanceGateBlocker[];
};

export type StandardHireAccessFacts = {
  /** Server-derived classification; do not populate from a client request. */
  standardNewHire: boolean;
  /** Source BGV clearance, not an operational-request completion. */
  bgvClear: boolean;
  /** Source HRIS worker activation, not an IAM or checklist assertion. */
  hrisActive: boolean;
};

/**
 * Canonical governance scopes at connector boundaries.  Human-readable
 * register labels must be mapped here rather than allowing a client to choose
 * an easier workflow scope for an effect.
 */
export type GovernanceWorkflow =
  | "worker-record-documents"
  | "background-verification"
  | "it-identity-access"
  | "assets-workplace"
  | "payroll-benefits"
  | "frontline-deployment"
  | "candidate-communications"
  | "candidate-voice"
  | "candidate-portal";

export function governanceWorkflowForConnectorMutation(input: {
  connector: "payroll" | "iam" | "background-verification" | "documents";
  operation: string;
}): GovernanceWorkflow {
  switch (input.connector) {
    case "payroll":
      return "payroll-benefits";
    case "iam":
      return "it-identity-access";
    case "background-verification":
      return "background-verification";
    case "documents":
      return "worker-record-documents";
  }
}

/**
 * This intentionally recognizes only ordinary employee new-hire shapes from
 * server-stored case data. Contractors, vendors, interns and transfers do
 * not become standard new hires because a browser labels them that way.
 */
export function standardNewHireForStoredCase(caseRow: {
  hireType: string;
  workerCategory: string;
}): boolean {
  const hireType = caseRow.hireType.trim().toLowerCase();
  const workerCategory = caseRow.workerCategory.trim().toLowerCase();
  return !["contractor", "vendor", "intern"].includes(workerCategory) &&
    ["new-hire", "external-fte", "external"].includes(hireType);
}

const live = (): GovernanceExecutionContext => ({ kind: "live" });
const isolatedSimulation = (): GovernanceExecutionContext => ({
  kind: "isolated-simulation",
});

/**
 * Construct context only after the server has classified the stored case.
 * In particular, no request-body `simulation` value is accepted here.
 */
export function executionContextForStoredCase(
  serverClassifiedCase: { isolatedSimulation: boolean },
): GovernanceExecutionContext {
  return serverClassifiedCase.isolatedSimulation ? isolatedSimulation() : live();
}

function workflowMatches(impactedWorkflows: readonly string[], workflow: string): boolean {
  // The evaluator receives canonical scopes from the immutable runtime
  // catalog or validated custom scope only. Register display labels cannot
  // accidentally authorize or broaden a live effect.
  return impactedWorkflows.some((impacted) => impacted === workflow || impacted === "*");
}

function validRevision(value: GovernanceDecisionRuntimeRevision): boolean {
  return Boolean(value.key.trim()) && Number.isInteger(value.revision) && value.revision > 0;
}

function standardHireBlockers(
  workflow: string,
  facts: StandardHireAccessFacts | undefined,
): GovernanceGateBlocker[] {
  if (
    !facts?.standardNewHire ||
    !["it-identity-access", "assets-workplace", "iam", "assets"].includes(workflow)
  ) {
    return [];
  }
  const blockers: GovernanceGateBlocker[] = [];
  if (!facts.bgvClear) {
    blockers.push({
      kind: "bgv-not-clear",
      key: "standard-new-hire-bgv",
      message: "Real access or asset release is blocked until the standard new hire has a clear BGV result.",
    });
  }
  if (!facts.hrisActive) {
    blockers.push({
      kind: "hris-not-active",
      key: "standard-new-hire-hris",
      message: "Real access or asset release is blocked until the standard new hire has an active HRIS record.",
    });
  }
  return blockers;
}

/**
 * Final server-side policy evaluation for one real-world workflow effect.
 * Simulation receives no external effect from its own provider boundary; it
 * may proceed through this decision evaluator so planning remains useful.
 */
export function evaluateGovernanceExecutionGate(input: {
  workflow: string;
  execution: GovernanceExecutionContext;
  decisions: readonly GovernanceDecisionRuntimeRevision[];
  requirements?: readonly GovernanceRequirementRuntimeState[];
  standardHireAccess?: StandardHireAccessFacts;
  /** Preserve an existing provider deny; governance can only add denials. */
  providerDispatchDenied?: boolean;
}): GovernanceExecutionGate {
  if (!input.workflow.trim()) {
    throw new Error("A workflow is required for governance execution evaluation.");
  }
  if (input.execution.kind === "isolated-simulation") {
    // Governance review does not prevent an isolated simulation from
    // progressing, but it may never reopen an existing provider deny scope.
    if (input.providerDispatchDenied) {
      return {
        allowed: false,
        execution: input.execution.kind,
        blockers: [{
          kind: "provider-policy-denied",
          key: "provider-policy",
          message: "Provider dispatch is denied by the existing server-side provider policy.",
        }],
      };
    }
    return {
      allowed: true,
      execution: input.execution.kind,
      blockers: [],
    };
  }

  const blockers: GovernanceGateBlocker[] = [];
  if (input.providerDispatchDenied) {
    blockers.push({
      kind: "provider-policy-denied",
      key: "provider-policy",
      message: "Provider dispatch is denied by the existing server-side provider policy.",
    });
  }
  for (const decision of input.decisions) {
    if (!validRevision(decision)) {
      throw new Error("Governance decision runtime state contains an invalid key or revision.");
    }
    if (!workflowMatches(decision.impactedWorkflows, input.workflow)) continue;
    if (decision.status !== "approved") {
      blockers.push({
        kind: "unapproved-sensitive-decision",
        key: decision.key,
        message: `${decision.title ?? decision.key} is ${decision.status}; its ${decision.domain} review must be approved before this live action.`,
      });
    }
    if (decision.status === "approved" && decision.reviewerAuthorityActive === false) {
      blockers.push({
        kind: "reviewer-authority-inactive",
        key: decision.key,
        message: `${decision.title ?? decision.key} no longer has an active verified reviewer authority for live use.`,
      });
    }
  }
  for (const requirement of input.requirements ?? []) {
    if (!requirement.key.trim() || !workflowMatches(requirement.impactedWorkflows, input.workflow)) {
      continue;
    }
    // Each prerequisite remains independent. In particular, configured is not
    // used as a proxy for evidence or live approval.
    if (!requirement.coverage.approvedForLive) {
      blockers.push({
        kind: "requirement-not-approved-for-live",
        key: requirement.key,
        message: `${requirement.key} is not approved for live use.`,
      });
    }
    // Tenant requirement configuration is not complete until both its
    // governance coverage record and any required provider are configured.
    // Keep the provider-specific blocker below as a distinct diagnostic.
    if (!requirement.coverage.configured || requirement.providerConfigured === false) {
      blockers.push({
        kind: "requirement-not-configured",
        key: requirement.key,
        message: `${requirement.key} is not configured for this live action.`,
      });
    }
    if (requirement.providerConfigured !== undefined && !requirement.providerConfigured) {
      blockers.push({
        kind: "provider-not-configured",
        key: requirement.key,
        message: `${requirement.key} has no configured provider for this live action.`,
      });
    }
    if (requirement.realEvidenceAvailable !== undefined && !requirement.realEvidenceAvailable) {
      blockers.push({
        kind: "evidence-not-available",
        key: requirement.key,
        message: `${requirement.key} has no required source-recorded evidence for this live action.`,
      });
    }
  }
  blockers.push(...standardHireBlockers(input.workflow, input.standardHireAccess));
  return { allowed: blockers.length === 0, execution: input.execution.kind, blockers };
}

const GOVERNANCE_REQUIREMENT_WORKFLOWS: Record<string, readonly string[]> = {
  "REQ-02": ["worker-record-documents"],
  "REQ-03": ["background-verification"],
  "REQ-05": ["it-identity-access"],
  "REQ-06": ["it-identity-access", "assets-workplace"],
  "REQ-07": ["payroll-benefits"],
  "REQ-09": ["it-identity-access", "assets-workplace"],
  "REQ-15": ["worker-record-documents", "background-verification"],
  "APP-A-09": ["payroll-benefits"],
};

function sensitiveDecisionDomain(row: {
  key: string;
  proposedValue: unknown;
}): { domain: GovernanceDecisionDomain; impactedWorkflows: readonly string[] } | null {
  // This catalog is a server-owned contract. Decision titles, rationale,
  // risks, and accountable-role labels are mutable review content and must
  // never select an execution gate.
  const catalog = GOVERNANCE_DECISION_RUNTIME_CATALOG[row.key];
  if (catalog) return catalog;
  return customRuntimeScope(row.proposedValue);
}

export const GOVERNANCE_DECISION_RUNTIME_CATALOG: Readonly<Record<string, {
  domain: GovernanceDecisionDomain;
  impactedWorkflows: readonly string[];
}>> = Object.freeze({
  "GD-04": { domain: "legal", impactedWorkflows: ["background-verification", "it-identity-access", "assets-workplace"] },
  "GD-06": { domain: "safety", impactedWorkflows: ["assets-workplace", "frontline-deployment"] },
  "GD-07": { domain: "legal", impactedWorkflows: ["background-verification"] },
  "GD-10": {
    domain: "privacy",
    impactedWorkflows: [
      "worker-record-documents",
      "payroll-benefits",
      "frontline-deployment",
      "candidate-communications",
      "candidate-voice",
      "candidate-portal",
    ],
  },
  "GD-11": { domain: "safety", impactedWorkflows: ["*"] },
});

const CUSTOM_RUNTIME_WORKFLOWS = new Set([
  "worker-record-documents",
  "background-verification",
  "it-identity-access",
  "assets-workplace",
  "payroll-benefits",
  "frontline-deployment",
  "candidate-communications",
  "candidate-voice",
  "candidate-portal",
]);

/**
 * A custom decision may gate execution only with this typed persisted shape:
 * `{ governanceRuntime: { domain, impactedWorkflows } }`. Browser labels and
 * human-readable impacted-workflow strings are never accepted as a scope.
 */
function customRuntimeScope(value: unknown): {
  domain: GovernanceDecisionDomain;
  impactedWorkflows: readonly string[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as { governanceRuntime?: unknown }).governanceRuntime;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const scope = candidate as { domain?: unknown; impactedWorkflows?: unknown };
  if (
    (scope.domain !== "legal" && scope.domain !== "privacy" && scope.domain !== "safety") ||
    !Array.isArray(scope.impactedWorkflows) ||
    scope.impactedWorkflows.length === 0 ||
    scope.impactedWorkflows.some((workflow) =>
      typeof workflow !== "string" || !CUSTOM_RUNTIME_WORKFLOWS.has(workflow))
  ) return null;
  return {
    domain: scope.domain,
    impactedWorkflows: [...new Set(scope.impactedWorkflows)],
  };
}

function providerKeyForWorkflow(workflow: string): string | null {
  switch (workflow) {
    case "background-verification":
      return "bgv";
    case "it-identity-access":
      return "itsm";
    case "payroll-benefits":
      return "payroll";
    default:
      return null;
  }
}

async function currentGovernanceRows(
  organizationId: string,
  tx: Pick<typeof db, "select"> = db,
) {
  const [decisions, requirements] = await Promise.all([
    tx.select().from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.isCurrent, true),
    )),
    tx.select().from(onbGovernanceRequirements).where(
      eq(onbGovernanceRequirements.organizationId, organizationId),
    ),
  ]);
  return { decisions, requirements };
}

/**
 * Query and evaluate the tenant state at the real connector boundary. All
 * source records include the organization predicate; an ID alone can never
 * borrow a different tenant's governance approval or readiness evidence.
 */
export async function evaluateStoredCaseGovernanceGate(input: {
  caseRow: {
    id: number;
    organizationId: string;
    workerName?: string;
    workerEmail: string;
    workerPhone?: string | null;
    notes?: string | null;
    joiningDate?: string;
    hireType: string;
    workerCategory: string;
    processPolicySnapshot?: unknown;
  };
  connector?: "payroll" | "iam" | "background-verification" | "documents";
  operation?: string;
  workflow?: GovernanceWorkflow;
}): Promise<GovernanceExecutionGate> {
  const organizationId = input.caseRow.organizationId;
  const execution = executionContextForStoredCase({
    isolatedSimulation: isSyntheticOfflineCase({
      workerName: input.caseRow.workerName,
      workerEmail: input.caseRow.workerEmail,
      workerPhone: input.caseRow.workerPhone,
      notes: input.caseRow.notes ?? null,
    }),
  });
  // A missing historical snapshot is never permission to issue a new live
  // effect. The case stays immutable, but current sensitive decisions and
  // provider/requirement facts still gate this future dispatch.
  const adoptedSnapshot = governanceDecisionSnapshotFromPolicy(
    (input.caseRow.processPolicySnapshot ?? {}) as Record<string, unknown>,
  );
  await ensureGovernanceSeeded(organizationId);
  const workflow = input.workflow ?? governanceWorkflowForConnectorMutation({
    connector: input.connector!,
    operation: input.operation ?? "",
  });
  const { decisions, requirements } = await currentGovernanceRows(organizationId);
  const providerKey = providerKeyForWorkflow(workflow);
  const [provider, checks, hrisState, activeAuthorities, allDecisionRevisions, decisionReviews, currentCase] = await Promise.all([
    providerKey
      ? db.select().from(onbConnectors).where(and(
        eq(onbConnectors.organizationId, organizationId),
        eq(onbConnectors.key, providerKey),
      )).limit(1)
      : Promise.resolve([]),
    db.select().from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, organizationId),
      eq(onbSystemChecks.caseId, input.caseRow.id),
    )),
    db.select().from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.organizationId, organizationId),
      eq(onbReadinessSlaCaseState.caseId, input.caseRow.id),
    )).limit(1),
    db.select().from(onbGovernanceAuthorityAssignments).where(and(
      eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
      eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
      isNull(onbGovernanceAuthorityAssignments.revokedAt),
      or(
        isNull(onbGovernanceAuthorityAssignments.expiresAt),
        gt(onbGovernanceAuthorityAssignments.expiresAt, new Date()),
      ),
    )),
    db.select().from(onbGovernanceDecisions).where(
      eq(onbGovernanceDecisions.organizationId, organizationId),
    ),
    db.select().from(onbGovernanceDecisionReviews).where(
      eq(onbGovernanceDecisionReviews.organizationId, organizationId),
    ),
    db.select({ joiningDate: onbCases.joiningDate }).from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      eq(onbCases.id, input.caseRow.id),
    )).limit(1),
  ]);
  const snapshotVersion = hrisState[0]?.snapshotVersion;
  const hrisAttestations = snapshotVersion === undefined
    ? []
    : await db.select().from(onbReadinessSlaAttestations).where(and(
      eq(onbReadinessSlaAttestations.organizationId, organizationId),
      eq(onbReadinessSlaAttestations.caseId, input.caseRow.id),
      eq(onbReadinessSlaAttestations.snapshotVersion, snapshotVersion),
      eq(onbReadinessSlaAttestations.streamKey, "hris"),
    )).orderBy(desc(onbReadinessSlaAttestations.id)).limit(1);

  if (
    !adoptedSnapshot &&
    execution.kind === "live" &&
    decisions.some((decision) => {
      const scope = sensitiveDecisionDomain(decision);
      return scope !== null && workflowMatches(scope.impactedWorkflows, workflow);
    })
  ) {
    return {
      allowed: false,
      execution: execution.kind,
      blockers: [{
        kind: "case-governance-snapshot-missing",
        key: "governance-case-snapshot",
        message: "This historical case has no audited governance adoption snapshot; rebase it before this sensitive live action.",
      }],
    };
  }
  return evaluateGovernanceExecutionGate({
    workflow,
    execution,
    decisions: (adoptedSnapshot?.decisions ?? []).map((adopted) => {
      const persisted = allDecisionRevisions.find((decision) =>
        decision.key === adopted.key && decision.revision === adopted.revision);
      // Approval made after this case adopted the exact same revision is
      // prospective. It requires a locked rebase and must not turn a
      // provisional snapshot live. Only direct rejection revokes an adopted
      // approval without changing the case snapshot.
      const status = persisted?.status === "rejected"
        ? "rejected" as const
        : adopted.status;
      const approvingReview = decisionReviews.find((review) =>
        review.decisionKey === adopted.key &&
        review.decisionRevision === adopted.revision &&
        review.outcome === "approved" &&
        review.reviewedByUserId === persisted?.approvedByUserId);
      return {
        key: adopted.key,
        revision: adopted.revision,
        status,
        domain: adopted.domain,
        impactedWorkflows: adopted.impactedWorkflows,
        title: persisted?.title,
        reviewerAuthorityActive: status !== "approved" || (
          approvingReview !== undefined &&
          activeAuthorities.some((assignment) => assignment.id === approvingReview.authorityAssignmentId)
        ),
      };
    }),
    requirements: requirements
      .filter((requirement) => (GOVERNANCE_REQUIREMENT_WORKFLOWS[requirement.key] ?? [])
        .some((scope) => scope === workflow))
      .map((requirement) => ({
        key: requirement.key,
        impactedWorkflows: GOVERNANCE_REQUIREMENT_WORKFLOWS[requirement.key] ?? [],
        coverage: {
          implemented: requirement.implemented,
          tested: requirement.tested,
          configured: requirement.configured,
          approvedForLive: requirement.approvedForLive,
        },
        // A selected "connected" label is not provider configuration. A live
        // source must have completed a server-recorded synchronization.
        providerConfigured: providerKey ? hasTrustedProviderConfiguration(provider[0]) : undefined,
        realEvidenceAvailable: workflow === "it-identity-access"
          ? hasTrustedBgvClearanceEvidence(checks)
          : undefined,
      })),
    standardHireAccess: {
      standardNewHire: standardNewHireForStoredCase(input.caseRow),
      bgvClear: hasTrustedBgvClearanceEvidence(checks),
        hrisActive: snapshotVersion !== undefined && currentCase[0] !== undefined && hasTrustedHrisActivationEvidence(hrisAttestations[0], {
          joiningDate: currentCase[0].joiningDate,
          snapshotVersion,
        }),
    },
  });
}

export type GovernanceCaseDecisionSnapshot = {
  key: string;
  revision: number;
  status: GovernanceDecisionStatus;
  domain: GovernanceDecisionDomain;
  impactedWorkflows: string[];
};

type GovernanceDecisionForAdoption = Pick<
  GovernanceDecisionRuntimeRevision,
  "key" | "revision" | "status" | "domain" | "impactedWorkflows"
>;

function validAdoptionRevision(value: GovernanceDecisionForAdoption): boolean {
  return Boolean(value.key.trim()) &&
    Number.isInteger(value.revision) &&
    value.revision > 0;
}

export type GovernanceCaseSnapshot = {
  schemaVersion: typeof GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION;
  version: number;
  adoptedAt: string;
  decisions: GovernanceCaseDecisionSnapshot[];
};

export class GovernanceCaseRebaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceCaseRebaseConflictError";
  }
}

function cloneSnapshot(snapshot: GovernanceCaseSnapshot): GovernanceCaseSnapshot {
  return {
    ...snapshot,
    decisions: snapshot.decisions.map((decision) => ({
      ...decision,
      impactedWorkflows: [...decision.impactedWorkflows],
    })),
  };
}

/**
 * Cases record every applicable sensitive revision and its state at adoption.
 * This is intentionally a narrow addition to the existing immutable
 * `processPolicySnapshot`; checklist/context policy fields are copied intact.
 */
export function adoptGovernanceDecisionSnapshot(input: {
  decisions: readonly GovernanceDecisionForAdoption[];
  adoptedAt: Date | string;
  version?: number;
}): GovernanceCaseSnapshot {
  const keys = new Set<string>();
  const decisions = input.decisions.map((decision) => {
    if (!validAdoptionRevision(decision) || keys.has(decision.key)) {
      throw new Error("Only unique, valid governance decision revisions can be adopted.");
    }
    keys.add(decision.key);
    return {
      key: decision.key,
      revision: decision.revision,
      status: decision.status,
      domain: decision.domain,
      impactedWorkflows: [...new Set(decision.impactedWorkflows)],
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
  const adoptedAt = input.adoptedAt instanceof Date
    ? input.adoptedAt.toISOString()
    : input.adoptedAt;
  if (Number.isNaN(new Date(adoptedAt).getTime())) {
    throw new Error("Governance decision adoption requires a valid timestamp.");
  }
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("Governance case snapshot version must be a non-negative integer.");
  }
  return {
    schemaVersion: GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION,
    version,
    adoptedAt,
    decisions,
  };
}

/**
 * Capture all current applicable sensitive register revisions (including
 * provisional/draft state) for a new case. Callers use
 * this only before insert; it never mutates an existing case's snapshot.
 */
export async function governanceSnapshotForNewCase(
  organizationId: string,
  adoptedAt: Date | string = new Date(),
  /**
   * Intake callers first seed outside their tenant dispatch transaction, then
   * pass that locked transaction here for the authoritative read.  Calling
   * ensureGovernanceSeeded from inside that transaction would open a second
   * session that waits on the same advisory lock and deadlocks intake.
   */
  tx?: Pick<typeof db, "select">,
): Promise<GovernanceCaseSnapshot> {
  if (!tx) await ensureGovernanceSeeded(organizationId);
  const { decisions } = await currentGovernanceRows(organizationId, tx ?? db);
  return adoptGovernanceDecisionSnapshot({
    decisions: decisions.flatMap((decision) => {
      const scope = sensitiveDecisionDomain(decision);
      return scope ? [{
        key: decision.key,
        revision: decision.revision,
        status: decision.status,
        domain: scope.domain,
        impactedWorkflows: [...scope.impactedWorkflows],
      }] : [];
    }),
    adoptedAt,
  });
}

export function withGovernanceDecisionSnapshot(
  processPolicySnapshot: Record<string, unknown>,
  governanceSnapshot: GovernanceCaseSnapshot,
): Record<string, unknown> {
  // Do not mutate a case's input object: it can be shared with batch intake
  // reconciliation and would otherwise turn a prospective adoption into an
  // active-case rewrite.
  return {
    ...structuredClone(processPolicySnapshot),
    governanceDecisionSnapshot: cloneSnapshot(governanceSnapshot),
  };
}

export function governanceDecisionSnapshotFromPolicy(
  processPolicySnapshot: Record<string, unknown>,
): GovernanceCaseSnapshot | null {
  const raw = processPolicySnapshot.governanceDecisionSnapshot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snapshot = raw as Partial<GovernanceCaseSnapshot>;
  if (
    snapshot.schemaVersion !== GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION ||
    !Number.isInteger(snapshot.version) ||
    (snapshot.version ?? -1) < 0 ||
    typeof snapshot.adoptedAt !== "string" ||
    !Array.isArray(snapshot.decisions)
  ) {
    return null;
  }
  const decisions = snapshot.decisions as GovernanceCaseDecisionSnapshot[];
  if (decisions.some((decision) =>
    !decision ||
    typeof decision.key !== "string" ||
    !Number.isInteger(decision.revision) ||
    decision.revision < 1 ||
    (decision.status !== "draft" && decision.status !== "provisional" &&
      decision.status !== "approved" && decision.status !== "rejected" &&
      decision.status !== "superseded") ||
    (decision.domain !== "legal" && decision.domain !== "privacy" && decision.domain !== "safety") ||
    !Array.isArray(decision.impactedWorkflows),
  )) return null;
  return cloneSnapshot(snapshot as GovernanceCaseSnapshot);
}

export type GovernanceCaseImpact = {
  key: string;
  adoptedRevision: number | null;
  currentRevision: number | null;
  impactedWorkflows: string[];
  reason: "revision-available" | "approval-revoked-or-missing" | "new-decision";
  blocksLiveActions: boolean;
};

/**
 * A current approved revision is visible as prospective impact only. It does
 * not silently replace the approved revision already attached to an active
 * case. A missing/unapproved current revision is a live blocker until an
 * explicit locked rebase receives fresh approval.
 */
export function assessGovernanceCaseImpact(input: {
  snapshot: GovernanceCaseSnapshot;
  currentDecisions: readonly GovernanceDecisionRuntimeRevision[];
}): GovernanceCaseImpact[] {
  const current = new Map(input.currentDecisions.map((decision) => [decision.key, decision]));
  const impacts: GovernanceCaseImpact[] = input.snapshot.decisions.flatMap((adopted): GovernanceCaseImpact[] => {
    const decision = current.get(adopted.key);
    const sameRevision = decision?.revision === adopted.revision;
    // A same-revision approval that occurred after a provisional/draft case
    // adoption is still prospective; only a rebase may adopt that approval.
    if (sameRevision && decision.status === adopted.status && decision.reviewerAuthorityActive !== false) return [];
    const blocked = !decision ||
      (sameRevision && decision.status === "rejected") ||
      (adopted.status === "approved" && decision.reviewerAuthorityActive === false);
    return [{
      key: adopted.key,
      adoptedRevision: adopted.revision,
      currentRevision: decision?.revision ?? null,
      impactedWorkflows: [...adopted.impactedWorkflows],
      reason: blocked ? "approval-revoked-or-missing" : "revision-available",
      blocksLiveActions: blocked,
    }];
  });
  // New current decisions are prospective and never overwrite a case
  // snapshot. They still appear to an operator, including provisional state,
  // so a conscious locked rebase can decide whether to adopt them.
  for (const decision of input.currentDecisions) {
    if (input.snapshot.decisions.some((adopted) => adopted.key === decision.key)) continue;
    impacts.push({
      key: decision.key,
      adoptedRevision: null,
      currentRevision: decision.revision,
      impactedWorkflows: [...decision.impactedWorkflows],
      reason: "new-decision",
      blocksLiveActions: false,
    });
  }
  return impacts;
}

/**
 * Tenant-scoped impact view for an existing case. It exposes revision or
 * revocation impact without changing the adopted case policy.
 */
export async function governanceCaseImpact(input: {
  organizationId: string;
  caseId: number;
}): Promise<{
  snapshot: GovernanceCaseSnapshot | null;
  impacts: GovernanceCaseImpact[];
}> {
  const [caseRow] = await db.select({
    processPolicySnapshot: onbCases.processPolicySnapshot,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId),
    eq(onbCases.id, input.caseId),
  )).limit(1);
  if (!caseRow) throw new Error("Case not found for governance impact.");
  const snapshot = governanceDecisionSnapshotFromPolicy(
    (caseRow.processPolicySnapshot ?? {}) as Record<string, unknown>,
  );
  if (!snapshot) return { snapshot: null, impacts: [] };
  await ensureGovernanceSeeded(input.organizationId);
  const [{ decisions }, reviews, activeAuthorities] = await Promise.all([
    currentGovernanceRows(input.organizationId),
    db.select().from(onbGovernanceDecisionReviews).where(
      eq(onbGovernanceDecisionReviews.organizationId, input.organizationId),
    ),
    db.select().from(onbGovernanceAuthorityAssignments).where(and(
      eq(onbGovernanceAuthorityAssignments.organizationId, input.organizationId),
      eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
      isNull(onbGovernanceAuthorityAssignments.revokedAt),
      or(isNull(onbGovernanceAuthorityAssignments.expiresAt),
        gt(onbGovernanceAuthorityAssignments.expiresAt, new Date())),
    )),
  ]);
  return {
    snapshot,
    impacts: assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: decisions.flatMap((decision) => {
        const scope = sensitiveDecisionDomain(decision);
        const adopted = snapshot.decisions.find((entry) => entry.key === decision.key);
        // Planning-only custom decisions have no executable scope and therefore
        // do not appear as a false live-impact record.
        const approvingReview = reviews.find((review) =>
          review.decisionKey === decision.key &&
          review.decisionRevision === (adopted?.revision ?? decision.revision) &&
          review.outcome === "approved");
        return scope ? [{
          key: decision.key,
          revision: decision.revision,
          status: decision.status,
          domain: scope.domain,
          impactedWorkflows: scope.impactedWorkflows,
          title: decision.title,
          reviewerAuthorityActive: (adopted?.status ?? decision.status) !== "approved" || (
            approvingReview !== undefined &&
            activeAuthorities.some((assignment) => assignment.id === approvingReview.authorityAssignmentId)
          ),
        }] : [];
      }),
    }),
  };
}

/**
 * This validates the compare-and-swap portion of a rebase. Persistence code
 * must call it while holding its case lock, then obtain a new final approval
 * rather than carrying a prior final approval forward.
 */
export function prepareGovernanceCaseRebase(input: {
  currentSnapshot: GovernanceCaseSnapshot;
  expectedSnapshotVersion: number;
  currentDecisions: readonly GovernanceDecisionRuntimeRevision[];
  adoptedAt: Date | string;
}): {
  nextSnapshot: GovernanceCaseSnapshot;
  freshFinalApprovalRequired: true;
} {
  if (input.currentSnapshot.version !== input.expectedSnapshotVersion) {
    throw new GovernanceCaseRebaseConflictError(
      `Governance case snapshot changed (current version ${input.currentSnapshot.version}).`,
    );
  }
  return {
    nextSnapshot: adoptGovernanceDecisionSnapshot({
      decisions: input.currentDecisions,
      adoptedAt: input.adoptedAt,
      version: input.currentSnapshot.version + 1,
    }),
    freshFinalApprovalRequired: true,
  };
}

/**
 * Locked, compare-and-swap governance adoption for an active case. It does
 * not replay connector effects. The existing final approval is explicitly
 * reopened so a reviewer must approve the newly adopted decision set.
 */
export async function rebaseGovernanceCase(input: {
  organizationId: string;
  caseId: number;
  expectedSnapshotVersion: number;
  reason: string;
  changedBy: string;
}): Promise<GovernanceCaseSnapshot> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required for a governance case rebase.");
  if (!Number.isInteger(input.expectedSnapshotVersion) || input.expectedSnapshotVersion < 0) {
    throw new GovernanceCaseRebaseConflictError("A non-negative expected governance snapshot version is required.");
  }
  await ensureGovernanceSeeded(input.organizationId);
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, input.organizationId);
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    await acquireCaseDispatchMutationLock(tx, input.organizationId, input.caseId);
    const [caseRow] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, input.organizationId),
      eq(onbCases.id, input.caseId),
    )).for("update");
    if (!caseRow) throw new Error("Case not found for governance rebase.");
    if (caseRow.lifecycleStage === "complete") {
      throw new Error("Completed cases cannot be rebased.");
    }
    if (await hasActiveCaseDispatchMarker(tx, input.organizationId, input.caseId)) {
      throw new Error("Case has an active provider dispatch; governance rebase was rejected.");
    }
    const policy = (caseRow.processPolicySnapshot ?? {}) as Record<string, unknown>;
    const currentSnapshot = governanceDecisionSnapshotFromPolicy(policy);
    if (!currentSnapshot && input.expectedSnapshotVersion !== 0) {
      throw new GovernanceCaseRebaseConflictError(
        "Case has no valid governance snapshot; use expectedSnapshotVersion 0 for explicit audited legacy adoption.",
      );
    }
    const { decisions } = await currentGovernanceRows(input.organizationId, tx);
    const currentDecisions = decisions.flatMap((decision) => {
        const scope = sensitiveDecisionDomain(decision);
        return scope ? [{
          key: decision.key,
          revision: decision.revision,
          status: decision.status,
          domain: scope.domain,
          impactedWorkflows: scope.impactedWorkflows,
        }] : [];
      });
    const prepared = currentSnapshot
      ? prepareGovernanceCaseRebase({
          currentSnapshot,
          expectedSnapshotVersion: input.expectedSnapshotVersion,
          currentDecisions,
          adoptedAt: new Date(),
        })
      : {
          nextSnapshot: adoptGovernanceDecisionSnapshot({
            decisions: currentDecisions,
            adoptedAt: new Date(),
            version: 0,
          }),
          freshFinalApprovalRequired: true as const,
        };
    const nextPolicy = withGovernanceDecisionSnapshot(policy, prepared.nextSnapshot);
    const [updated] = await tx.update(onbCases).set({
      processPolicySnapshot: nextPolicy,
      updatedAt: new Date(),
    }).where(and(
      eq(onbCases.organizationId, input.organizationId),
      eq(onbCases.id, input.caseId),
    )).returning({ id: onbCases.id });
    if (!updated) throw new GovernanceCaseRebaseConflictError("Case was concurrently changed before governance rebase.");
    await reopenGateCApprovalInTransaction(
      tx,
      input.organizationId,
      input.caseId,
      `Gate C reopened because governance decisions were rebased: ${reason}`,
      input.changedBy,
    );
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "governance-runtime",
      engine: "human",
      hitlPattern: "hard-block",
      ruleRef: "Governance decision case rebase",
      title: "Governance decision snapshot rebased",
      detail: currentSnapshot
        ? `${input.changedBy} rebased governance snapshot ${currentSnapshot.version} to ${prepared.nextSnapshot.version}: ${reason}. Existing provider effects were not replayed.`
        : `${input.changedBy} explicitly adopted legacy governance state at version 0: ${reason}. Existing provider effects were not replayed.`,
      idempotencyKey: currentSnapshot
        ? `governance:${input.caseId}:rebase:${prepared.nextSnapshot.version}`
        : `governance:${input.caseId}:legacy-adoption:v0`,
    }).onConflictDoNothing({
      target: [onbEvents.organizationId, onbEvents.idempotencyKey],
    });
    return prepared.nextSnapshot;
  }));
}