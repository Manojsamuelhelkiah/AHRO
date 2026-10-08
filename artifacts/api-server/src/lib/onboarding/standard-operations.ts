import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  onbCases,
  onbEmployeeRecords,
  onbEvents,
  onbStandardIntakeEvents,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbFrontlineReleaseState,
  onbSettings,
  onbSystemChecks,
} from "@workspace/db";
import {
  hasTrustedBgvClearanceEvidence,
  hasTrustedHrisActivationEvidence,
} from "./connector-evidence-provenance";
import { hasCurrentVaultBgvReceipt } from "../employee-vault/reuse";
import {
  resolveCurrentCaseExecutionAuthorityEvidence,
} from "./decision-authority";
import { standardNewHireForStoredCase } from "./governance-runtime";
import {
  approvedRehireReusePolicy,
  approvedStandardOperationsPolicy,
  MANUAL_CONSENT_STATUS,
  MANUAL_CUTOFF_STATUS,
  MANUAL_EVIDENCE_STATUS,
  MANUAL_FAILURE_STATUS,
  MANUAL_FULFILLMENT_AREAS,
  MANUAL_FULFILLMENT_STATUS,
  MANUAL_RECONCILIATION_STATUS,
  START_DATE_IMPACT_STREAMS,
  type ManualFulfillmentArea,
  type StartDateImpactStream,
  type StandardOperationExceptionType,
} from "./standard-operations-schema";
import type { OnboardingDbTransaction } from "./settings";
import { assertGovernanceMutationAllowed } from "./governance-dispatch";
import { scheduledPreboardingDueAt } from "./standard-intake";
import { evaluateFrontlineFloorReadinessInTransaction } from "./frontline-operations";
import {
  acquireCaseDispatchMutationLock,
  hasActiveCaseDispatchMarker,
} from "./dispatch-guard";

export const STANDARD_OPERATIONS_SETTING_PREFIX = "standard_operations:";

type StoredException = {
  type: StandardOperationExceptionType;
  state: "active" | "resolved";
  updatedAt: string;
  updatedBy: string;
};

type StoredStandardOperationsState = {
  version: number;
  exceptions: StoredException[];
  startDateReconciliation?: {
    from: string;
    to: string;
    updatedAt: string;
    updatedBy: string;
    impacts: Partial<Record<StartDateImpactStream, {
      resolution: "source-proof" | "manual-resolution";
      updatedAt: string;
      updatedBy: string;
      sourceProof?: {
        evidenceId: string;
        evidenceVersion: string;
        sourceStartDate: string;
        verifiedAt: string;
      };
    }>>;
  };
  manualFulfillment?: Partial<Record<ManualFulfillmentArea, ManualFulfillmentState>>;
};

type ManualFulfillmentState = {
  status: typeof MANUAL_FULFILLMENT_STATUS[number];
  evidenceStatus: typeof MANUAL_EVIDENCE_STATUS[number];
  consentStatus: typeof MANUAL_CONSENT_STATUS[number];
  cutoffStatus: typeof MANUAL_CUTOFF_STATUS[number];
  reconciliationStatus: typeof MANUAL_RECONCILIATION_STATUS[number];
  failureStatus: typeof MANUAL_FAILURE_STATUS[number];
  updatedAt: string;
  updatedBy: string;
};

export type StandardOperationsFacts = {
  standardNewHire: boolean;
  bgvApplicable: boolean;
  bgvClear: boolean;
  hrisActive: boolean;
  hrisSourceAuthoritative: boolean;
  currentAccessApproval: boolean;
  payrollCutoffKnown: boolean;
  rehire: boolean;
  validRehireSource: boolean;
  approvedRehireReusePolicy: boolean;
  approvedConditionalJoinPolicy: boolean;
  manualHolds: readonly StandardOperationExceptionType[];
  /** Site/floor work is deliberately released only by the dedicated live
   * frontline boundary; this standard access projection is never a bypass. */
  frontlineFloorBoundaryRequired?: boolean;
  frontlineFloorLiveEligible?: boolean;
};

export type StandardOperationsView = {
  caseId: number;
  version: number;
  startDate: string;
  preparation: {
    allowed: true;
    message: string;
  };
  startDateImpacts: Array<{
    stream: StartDateImpactStream;
    owner: string;
    status: "review-required" | "source-confirmed" | "manual-resolution";
  }>;
  startDateReconciliation: {
    state: "not-required" | "pending-review" | "complete";
    message: string;
  };
  rehireReuse: {
    eligible: boolean;
    message: string;
  };
  conditionalJoin: {
    enabled: boolean;
    message: string;
  };
  release: {
    access: { eligible: boolean; blockers: string[] };
    assets: { eligible: boolean; blockers: string[] };
  };
  exceptions: Array<{
    type: StandardOperationExceptionType;
    owner: "HR Operations";
    state: "held" | "clear";
    message: string;
  }>;
  manualFulfillment: Array<{
    area: ManualFulfillmentArea;
    status: ManualFulfillmentState["status"];
    evidenceStatus: ManualFulfillmentState["evidenceStatus"];
    consentStatus: ManualFulfillmentState["consentStatus"];
    cutoffStatus: ManualFulfillmentState["cutoffStatus"];
    reconciliationStatus: ManualFulfillmentState["reconciliationStatus"];
    failureStatus: ManualFulfillmentState["failureStatus"];
  }>;
};

export class StandardOperationsNotFoundError extends Error {
  constructor() {
    super("Case not found");
    this.name = "StandardOperationsNotFoundError";
  }
}

export class StandardOperationsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandardOperationsConflictError";
  }
}

/**
 * Standard-operations decisions can affect whether a pending provider release
 * is allowed. Serialize them with durable dispatch-marker creation before
 * loading state, then fail closed for both in-flight and ambiguous effects.
 * The returned row remains locked for the rest of this transaction.
 */
async function lockMutableStandardOperationsCase(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
): Promise<typeof onbCases.$inferSelect> {
  await acquireCaseDispatchMutationLock(tx, organizationId, caseId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`standard-operations:${organizationId}:${caseId}`}))`);
  const [caseRow] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    eq(onbCases.id, caseId),
  )).for("update");
  if (!caseRow) throw new StandardOperationsNotFoundError();
  if (caseRow.lifecycleStage === "complete") {
    throw new StandardOperationsConflictError(
      "Completed cases are immutable; standard-operations state must be recorded before completion.",
    );
  }
  if (await hasActiveCaseDispatchMarker(tx, organizationId, caseId)) {
    throw new StandardOperationsConflictError(
      "A provider dispatch is active or requires manual repair; reconcile it before changing standard-operations state.",
    );
  }
  return caseRow;
}

function settingKey(caseId: number): string {
  return `${STANDARD_OPERATIONS_SETTING_PREFIX}${caseId}`;
}

function emptyState(): StoredStandardOperationsState {
  return { version: 0, exceptions: [] };
}

function defaultManualFulfillment(area: ManualFulfillmentArea): ManualFulfillmentState {
  return {
    status: "not-started",
    evidenceStatus: "not-recorded",
    consentStatus: area === "bgv" ? "pending" : "not-applicable",
    cutoffStatus: area === "payroll" ? "unknown" : "not-applicable",
    reconciliationStatus: "not-started",
    failureStatus: "none",
    updatedAt: "",
    updatedBy: "",
  };
}

function validManualFulfillment(value: unknown): value is ManualFulfillmentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (MANUAL_FULFILLMENT_STATUS as readonly string[]).includes(entry.status as string) &&
    (MANUAL_EVIDENCE_STATUS as readonly string[]).includes(entry.evidenceStatus as string) &&
    (MANUAL_CONSENT_STATUS as readonly string[]).includes(entry.consentStatus as string) &&
    (MANUAL_CUTOFF_STATUS as readonly string[]).includes(entry.cutoffStatus as string) &&
    (MANUAL_RECONCILIATION_STATUS as readonly string[]).includes(entry.reconciliationStatus as string) &&
    (MANUAL_FAILURE_STATUS as readonly string[]).includes(entry.failureStatus as string) &&
    typeof entry.updatedAt === "string" &&
    typeof entry.updatedBy === "string";
}

function parseState(raw: string | null): StoredStandardOperationsState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredStandardOperationsState>;
    // Earlier status-only date reviews were never source reconciliation
    // evidence. Preserve them as an all-stream-pending plan rather than
    // treating their historical generic acknowledgement as completion.
    if (parsed.startDateReconciliation && !parsed.startDateReconciliation.impacts) {
      parsed.startDateReconciliation.impacts = {};
    }
    if (!Number.isInteger(parsed.version) || (parsed.version ?? -1) < 0 ||
      !Array.isArray(parsed.exceptions) ||
      parsed.exceptions.some((entry) =>
        !entry ||
        !["no-response", "payroll-cutoff", "delayed-bgv"].includes(entry.type) ||
        !["active", "resolved"].includes(entry.state) ||
        typeof entry.updatedAt !== "string" ||
        typeof entry.updatedBy !== "string",
      ) ||
      (parsed.startDateReconciliation !== undefined && (
        !parsed.startDateReconciliation ||
        !/^\d{4}-\d{2}-\d{2}$/.test(parsed.startDateReconciliation.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(parsed.startDateReconciliation.to) ||
        typeof parsed.startDateReconciliation.updatedAt !== "string" ||
        typeof parsed.startDateReconciliation.updatedBy !== "string" ||
        !parsed.startDateReconciliation.impacts ||
        typeof parsed.startDateReconciliation.impacts !== "object" ||
        Array.isArray(parsed.startDateReconciliation.impacts) ||
        Object.entries(parsed.startDateReconciliation.impacts).some(([stream, impact]) =>
          !(START_DATE_IMPACT_STREAMS as readonly string[]).includes(stream) ||
          !impact || typeof impact !== "object" || Array.isArray(impact) ||
          !["source-proof", "manual-resolution"].includes((impact as { resolution?: unknown }).resolution as string) ||
          typeof (impact as { updatedAt?: unknown }).updatedAt !== "string" ||
          typeof (impact as { updatedBy?: unknown }).updatedBy !== "string" ||
          ((impact as { sourceProof?: unknown }).sourceProof !== undefined && (
            !(impact as { sourceProof?: unknown }).sourceProof ||
            typeof (impact as { sourceProof?: unknown }).sourceProof !== "object" ||
            Array.isArray((impact as { sourceProof?: unknown }).sourceProof) ||
            typeof ((impact as { sourceProof: { evidenceId?: unknown } }).sourceProof.evidenceId) !== "string" ||
            typeof ((impact as { sourceProof: { evidenceVersion?: unknown } }).sourceProof.evidenceVersion) !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(String((impact as { sourceProof: { sourceStartDate?: unknown } }).sourceProof.sourceStartDate)) ||
            typeof ((impact as { sourceProof: { verifiedAt?: unknown } }).sourceProof.verifiedAt) !== "string"
          )))
      )) ||
      (parsed.manualFulfillment !== undefined && (
        !parsed.manualFulfillment ||
        typeof parsed.manualFulfillment !== "object" ||
        Array.isArray(parsed.manualFulfillment) ||
        Object.entries(parsed.manualFulfillment).some(([area, value]) =>
          !(MANUAL_FULFILLMENT_AREAS as readonly string[]).includes(area) ||
          !validManualFulfillment(value))
      ))) {
      throw new Error("invalid");
    }
    return {
      version: parsed.version!,
      exceptions: parsed.exceptions as StoredException[],
      ...(parsed.startDateReconciliation
        ? { startDateReconciliation: parsed.startDateReconciliation }
        : {}),
      ...(parsed.manualFulfillment ? { manualFulfillment: parsed.manualFulfillment } : {}),
    };
  } catch {
    throw new StandardOperationsConflictError(
      "Standard-operations hold state is malformed; no action was applied.",
    );
  }
}

function policyRequiresBgv(snapshot: Record<string, unknown>): boolean {
  const root = snapshot.standardOperations;
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  // A non-standard worker is only BGV-applicable when the case snapshot says
  // so under an approved policy. No value can switch off the standard-hire
  // requirement.
  const requirement = (root as Record<string, unknown>).bgvRequirement;
  return Boolean(
    requirement &&
    typeof requirement === "object" &&
    !Array.isArray(requirement) &&
    (requirement as Record<string, unknown>).status === "approved" &&
    (requirement as Record<string, unknown>).requiresBgv === true &&
    typeof (requirement as Record<string, unknown>).policyReference === "string" &&
    String((requirement as Record<string, unknown>).policyReference).trim().length > 0 &&
    typeof (requirement as Record<string, unknown>).approvalReference === "string" &&
    String((requirement as Record<string, unknown>).approvalReference).trim().length > 0,
  );
}

export function evaluateStandardOperations(input: {
  caseId: number;
  startDate: string;
  state: StoredStandardOperationsState;
  facts: StandardOperationsFacts;
}): StandardOperationsView {
  const automaticHolds = new Set<StandardOperationExceptionType>();
  if (!input.facts.payrollCutoffKnown) automaticHolds.add("payroll-cutoff");
  if (input.facts.bgvApplicable && !input.facts.bgvClear) automaticHolds.add("delayed-bgv");
  for (const type of input.facts.manualHolds) automaticHolds.add(type);

  // Payroll-cutoff holds protect payroll/benefits timing. They must not be
  // misrepresented as BGV/HRIS access evidence or silently broadened into an
  // access/asset release condition.
  const outstandingStartDateImpacts = START_DATE_IMPACT_STREAMS.filter(
    (stream) => !input.state.startDateReconciliation?.impacts[stream],
  );
  const accessReleaseHold = automaticHolds.has("no-response") ||
    automaticHolds.has("delayed-bgv") ||
    outstandingStartDateImpacts.length > 0 && input.state.startDateReconciliation !== undefined;
  const activeAccessHoldTypes = [
    ...(automaticHolds.has("no-response") ? ["no-response"] : []),
    ...(automaticHolds.has("delayed-bgv") ? ["delayed-bgv"] : []),
  ];
  const releaseBlockers = [
    ...(input.facts.frontlineFloorBoundaryRequired && !input.facts.frontlineFloorLiveEligible
      ? ["Frontline/site floor release is evaluated only by the dedicated live frontline boundary."] : []),
    ...(input.facts.bgvApplicable && !input.facts.bgvClear
      ? ["Applicable BGV clearance has not been received from a trusted source."] : []),
    ...(!input.facts.hrisActive
      ? ["A current authoritative HRIS activation record is required."] : []),
    ...(!input.facts.currentAccessApproval
      ? ["A current scoped IT-security execution approval is required."] : []),
    ...(input.state.startDateReconciliation !== undefined && outstandingStartDateImpacts.length > 0
      ? [`The changed start date still requires reconciliation for: ${outstandingStartDateImpacts.join(", ")}.`] : []),
    ...(accessReleaseHold
      ? [`An HR Operations ${activeAccessHoldTypes.length > 0
        ? `${activeAccessHoldTypes.join(" and ")} hold remains active.`
        : "date-reconciliation hold remains active."}`]
      : []),
  ];
  const exceptionMessage: Record<StandardOperationExceptionType, string> = {
    "no-response": "Awaiting an accountable response; no release is authorized by silence.",
    "payroll-cutoff": "Payroll cutoff must be reviewed before payroll or benefits timing is relied upon.",
    "delayed-bgv": "Applicable BGV clearance is delayed or absent; release remains held.",
  };
  const streamOwners = {
    hris: "HRIS Operations",
    provisioning: "IT / Security",
    payroll: "Payroll Operations",
    benefits: "Benefits Operations",
    schedules: "Workforce Scheduling",
  } as const;

  return {
    caseId: input.caseId,
    version: input.state.version,
    startDate: input.startDate,
    // Planning/preparation remains visibly separate from release. It creates
    // neither an account, asset dispatch, payroll enrollment, nor schedule.
    preparation: {
      allowed: true,
      message: "Preparation and reconciliation planning may proceed; no access, asset, payroll, benefits, or schedule release is performed here.",
    },
    startDateImpacts: START_DATE_IMPACT_STREAMS.map((stream) => ({
      stream,
      owner: streamOwners[stream],
      status: input.state.startDateReconciliation?.impacts[stream]?.resolution === "source-proof"
        ? "source-confirmed"
        : input.state.startDateReconciliation?.impacts[stream]?.resolution === "manual-resolution"
          ? "manual-resolution"
          : "review-required",
    })),
    startDateReconciliation: {
      state: !input.state.startDateReconciliation
        ? "not-required"
        : outstandingStartDateImpacts.length > 0 ? "pending-review" : "complete",
      message: !input.state.startDateReconciliation
        ? "No start-date change is awaiting reconciliation."
        : outstandingStartDateImpacts.length > 0
          ? `The date change is held pending ${outstandingStartDateImpacts.length} accountable stream reconciliation(s).`
          : "All date-change impacts have accountable resolutions. Independent release evidence and approvals remain required.",
    },
    rehireReuse: {
      eligible: input.facts.rehire &&
        input.facts.validRehireSource &&
        input.facts.approvedRehireReusePolicy,
      message: !input.facts.rehire
        ? "Not a rehire case."
        : input.facts.validRehireSource && input.facts.approvedRehireReusePolicy
          ? "Reuse may be considered from the validated authoritative source under the approved case policy; it is not performed by this plan."
          : "Reuse is held: both valid source evidence and an approved case policy are required.",
    },
    conditionalJoin: {
      enabled: input.facts.approvedConditionalJoinPolicy,
      message: input.facts.approvedConditionalJoinPolicy
        ? "Conditional join is policy-enabled, but does not bypass any release gate."
        : "Conditional join is disabled because no approved case policy evidence is present.",
    },
    release: {
      access: { eligible: releaseBlockers.length === 0, blockers: releaseBlockers },
      assets: { eligible: releaseBlockers.length === 0, blockers: releaseBlockers },
    },
    exceptions: (["no-response", "payroll-cutoff", "delayed-bgv"] as const).map((type) => ({
      type,
      owner: "HR Operations" as const,
      state: automaticHolds.has(type) ? "held" : "clear",
      message: exceptionMessage[type],
    })),
    // These durable manual-work records are intentionally separate from live
    // readiness and release. An operator may account for consent, cutoff,
    // reconciliation, or a failure without that status becoming provider
    // evidence or an enrollment assertion.
    manualFulfillment: MANUAL_FULFILLMENT_AREAS.map((area) => {
      const manual = input.state.manualFulfillment?.[area] ?? defaultManualFulfillment(area);
      return {
        area,
        status: manual.status,
        evidenceStatus: manual.evidenceStatus,
        consentStatus: manual.consentStatus,
        cutoffStatus: manual.cutoffStatus,
        reconciliationStatus: manual.reconciliationStatus,
        failureStatus: manual.failureStatus,
      };
    }),
  };
}

export async function getStandardOperationsViewInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
  lockedCaseRow?: typeof onbCases.$inferSelect,
): Promise<StandardOperationsView> {
  const [loadedCase] = lockedCaseRow ? [lockedCaseRow] : await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    eq(onbCases.id, caseId),
  ));
  const caseRow = loadedCase;
  if (!caseRow) throw new StandardOperationsNotFoundError();

  const [stored, bgvChecks, hrisAttestations, payrollState, records, frontlineState] =
    await Promise.all([
      tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, settingKey(caseId)),
      )),
      tx.select().from(onbSystemChecks).where(and(
        eq(onbSystemChecks.organizationId, organizationId),
        eq(onbSystemChecks.caseId, caseId),
        eq(onbSystemChecks.system, "bgv"),
      )),
      tx.select().from(onbReadinessSlaAttestations).where(and(
        eq(onbReadinessSlaAttestations.organizationId, organizationId),
        eq(onbReadinessSlaAttestations.caseId, caseId),
        eq(onbReadinessSlaAttestations.streamKey, "hris"),
      )).orderBy(desc(onbReadinessSlaAttestations.createdAt)).limit(1),
      tx.select().from(onbReadinessSlaCaseState).where(and(
        eq(onbReadinessSlaCaseState.organizationId, organizationId),
        eq(onbReadinessSlaCaseState.caseId, caseId),
      )),
      caseRow.hireType === "rehire"
        ? tx.select().from(onbEmployeeRecords).where(and(
          eq(onbEmployeeRecords.organizationId, organizationId),
          eq(onbEmployeeRecords.workerEmail, caseRow.workerEmail.trim().toLowerCase()),
          eq(onbEmployeeRecords.rehireEligible, true),
        ))
        : Promise.resolve([]),
      tx.select().from(onbFrontlineReleaseState).where(and(
        eq(onbFrontlineReleaseState.organizationId, organizationId),
        eq(onbFrontlineReleaseState.caseId, caseId),
      )),
    ]);
  const approval = await resolveCurrentCaseExecutionAuthorityEvidence(tx, {
      organizationId,
      caseId,
      connector: "iam",
    });
  const trustedHris = hasTrustedHrisActivationEvidence(hrisAttestations[0], {
    joiningDate: caseRow.joiningDate,
    snapshotVersion: payrollState[0]?.snapshotVersion ?? -1,
  });
  const snapshot = caseRow.processPolicySnapshot ?? {};
  const state = parseState(stored[0]?.value ?? null);
  const frontlineRequired =
    caseRow.workforceContext.workEnvironment === "site" ||
    caseRow.workforceContext.workEnvironment === "field" ||
    caseRow.workforceContext.workEnvironment === "mixed" ||
    caseRow.workforceContext.siteExposure === true ||
    caseRow.workforceContext.safetyCritical === true;
  const liveFrontline = frontlineRequired
    ? await evaluateFrontlineFloorReadinessInTransaction(tx, caseRow)
    : { applicable: false, blockers: [] };
  return evaluateStandardOperations({
    caseId,
    startDate: caseRow.joiningDate,
    state,
    facts: {
      standardNewHire: standardNewHireForStoredCase(caseRow),
      bgvApplicable: standardNewHireForStoredCase(caseRow) || policyRequiresBgv(snapshot),
      bgvClear: hasTrustedBgvClearanceEvidence(bgvChecks) || await hasCurrentVaultBgvReceipt(tx, organizationId, caseId),
      hrisActive: trustedHris,
      // Provider provenance is authoritative only when its effective date,
      // source receipt, and SLA snapshot remain bound to this case.
      hrisSourceAuthoritative: trustedHris,
      currentAccessApproval: approval.allowed,
      payrollCutoffKnown: payrollState[0]?.payrollCutoff !== null &&
        payrollState[0]?.payrollCutoff !== undefined,
      rehire: caseRow.hireType === "rehire",
      validRehireSource: records.length > 0,
      approvedRehireReusePolicy: approvedRehireReusePolicy(
        snapshot,
        records.map((record) => record.id),
      ),
      approvedConditionalJoinPolicy: approvedStandardOperationsPolicy(snapshot, "conditionalJoin") !== null,
      manualHolds: state.exceptions
        .filter((entry) => entry.state === "active")
        .map((entry) => entry.type),
      frontlineFloorBoundaryRequired: frontlineRequired,
      frontlineFloorLiveEligible:
        frontlineState[0]?.status === "released" && liveFrontline.applicable && liveFrontline.blockers.length === 0,
    },
  });
}

export async function getStandardOperationsView(
  organizationId: string,
  caseId: number,
): Promise<StandardOperationsView> {
  return db.transaction((tx) => getStandardOperationsViewInTransaction(tx, organizationId, caseId));
}

export async function setStandardOperationsException(input: {
  organizationId: string;
  caseId: number;
  type: StandardOperationExceptionType;
  expectedVersion: number;
  actorUserId: string;
  resolve?: boolean;
}): Promise<StandardOperationsView> {
  await db.transaction(async (tx) => {
    await lockMutableStandardOperationsCase(tx, input.organizationId, input.caseId);
    const [stored] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, settingKey(input.caseId)),
    )).for("update");
    const state = parseState(stored?.value ?? null);
    if (state.version !== input.expectedVersion) {
      throw new StandardOperationsConflictError(
        `Standard-operations holds changed since they were loaded (current version ${state.version}).`,
      );
    }
    const at = new Date().toISOString();
    const existing = state.exceptions.find((entry) => entry.type === input.type);
    if (existing) {
      existing.state = input.resolve ? "resolved" : "active";
      existing.updatedAt = at;
      existing.updatedBy = input.actorUserId;
    } else {
      state.exceptions.push({
        type: input.type,
        state: input.resolve ? "resolved" : "active",
        updatedAt: at,
        updatedBy: input.actorUserId,
      });
    }
    state.version += 1;
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: settingKey(input.caseId),
      value: JSON.stringify(state),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(state), updatedAt: sql`now()` },
    });
    // Do not store the client rationale: it is opaque free text and may carry
    // payroll, BGV, or employment-history data. The status projection is the
    // only durable operational record in this module.
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "standard-operations",
      engine: "rules",
      hitlPattern: "human-review",
      ruleRef: "Standard operations exception hold",
      title: `HR Operations ${input.resolve ? "resolved" : "placed"} ${input.type} hold`,
      detail: "A status-only exception decision was recorded. This does not authorize external release or change source evidence.",
      idempotencyKey: `standard-operations:${input.caseId}:${input.type}:${state.version}`,
    });
  });
  // Re-read provider facts only after the hold decision committed. Returning a
  // locally constructed view would turn unknown evidence into a misleading
  // "not clear" assertion and could race a real source update.
  return getStandardOperationsView(input.organizationId, input.caseId);
}

export async function setStandardOperationsManualFulfillment(input: {
  organizationId: string;
  caseId: number;
  area: ManualFulfillmentArea;
  expectedVersion: number;
  actorUserId: string;
  status: ManualFulfillmentState["status"];
  evidenceStatus: ManualFulfillmentState["evidenceStatus"];
  consentStatus: ManualFulfillmentState["consentStatus"];
  cutoffStatus: ManualFulfillmentState["cutoffStatus"];
  reconciliationStatus: ManualFulfillmentState["reconciliationStatus"];
  failureStatus: ManualFulfillmentState["failureStatus"];
}): Promise<StandardOperationsView> {
  await db.transaction(async (tx) => {
    await lockMutableStandardOperationsCase(tx, input.organizationId, input.caseId);
    await assertGovernanceMutationAllowed(tx, input.organizationId);
    const [stored] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, settingKey(input.caseId)),
    )).for("update");
    const state = parseState(stored?.value ?? null);
    if (state.version !== input.expectedVersion) {
      throw new StandardOperationsConflictError(
        `Standard-operations state changed since it was loaded (current version ${state.version}).`,
      );
    }
    const at = new Date().toISOString();
    state.manualFulfillment = {
      ...state.manualFulfillment,
      [input.area]: {
        status: input.status,
        evidenceStatus: input.evidenceStatus,
        consentStatus: input.consentStatus,
        cutoffStatus: input.cutoffStatus,
        reconciliationStatus: input.reconciliationStatus,
        failureStatus: input.failureStatus,
        updatedAt: at,
        updatedBy: input.actorUserId,
      },
    };
    state.version += 1;
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: settingKey(input.caseId),
      value: JSON.stringify(state),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(state), updatedAt: sql`now()` },
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "standard-operations",
      engine: "human",
      hitlPattern: "human-review",
      ruleRef: "Manual fulfillment status",
      title: `Manual ${input.area} fulfillment status recorded`,
      detail: "A restricted, status-only manual fulfillment record was updated. It does not assert live enrollment, provider evidence, readiness, or release.",
      idempotencyKey: `standard-operations:${input.caseId}:manual:${input.area}:${state.version}`,
    });
  });
  return getStandardOperationsView(input.organizationId, input.caseId);
}

/**
 * A date correction is a local case change only. It is intentionally fenced
 * from any provider dispatch and opens a fresh cross-functional review; a
 * changed date can never reuse the prior payroll, benefits, HRIS, schedule,
 * asset, or access timing conclusion.
 */
export async function changeStandardOperationsStartDate(input: {
  organizationId: string;
  caseId: number;
  startDate: string;
  expectedVersion: number;
  actorUserId: string;
}): Promise<StandardOperationsView> {
  await db.transaction(async (tx) => {
    const caseRow = await lockMutableStandardOperationsCase(
      tx,
      input.organizationId,
      input.caseId,
    );
    const [stored] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, settingKey(input.caseId)),
    )).for("update");
    const state = parseState(stored?.value ?? null);
    if (state.version !== input.expectedVersion) {
      throw new StandardOperationsConflictError(
        `Standard-operations holds changed since they were loaded (current version ${state.version}).`,
      );
    }
    if (caseRow.joiningDate === input.startDate) {
      throw new StandardOperationsConflictError("The supplied start date is already current; no reconciliation plan was changed.");
    }
    const at = new Date().toISOString();
    state.startDateReconciliation = {
      from: caseRow.joiningDate,
      to: input.startDate,
      updatedAt: at,
      updatedBy: input.actorUserId,
      impacts: {},
    };
    state.version += 1;
    await tx.update(onbCases).set({
      joiningDate: input.startDate,
      updatedAt: new Date(),
    }).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)));
    // A trusted Oracle attestation is bound to the old effective date. Record
    // an explicit invalidation in the active SLA cohort so no reader can pick
    // the older positive row while a fresh provider observation is pending.
    const [slaState] = await tx.select({
      snapshotVersion: onbReadinessSlaCaseState.snapshotVersion,
    }).from(onbReadinessSlaCaseState).where(and(
      eq(onbReadinessSlaCaseState.organizationId, input.organizationId),
      eq(onbReadinessSlaCaseState.caseId, input.caseId),
    )).for("update");
    if (slaState) {
      await tx.insert(onbReadinessSlaAttestations).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        snapshotVersion: slaState.snapshotVersion,
        streamKey: "hris",
        complete: false,
        evidenceProvenance: "unknown",
        reason: "Joining date changed; prior HRIS activation evidence is invalid until Oracle HCM confirms the current effective date.",
        attestedBy: "standard-operations-date-change",
        attestedRole: "system",
      });
    }
    // Scheduled standard-intake cases must never retain the old due window.
    // Only unreleased scheduler-held events are reset; a released source event
    // is historical and cannot be silently re-held by a date correction.
    await tx.update(onbStandardIntakeEvents).set({
      activationDueAt: scheduledPreboardingDueAt(input.startDate),
      activationStatus: "scheduled",
      activationReviewRequestedAt: null,
    }).where(and(
      eq(onbStandardIntakeEvents.organizationId, input.organizationId),
      eq(onbStandardIntakeEvents.caseId, input.caseId),
      eq(onbStandardIntakeEvents.eventType, "scheduled-preboarding"),
      inArray(onbStandardIntakeEvents.activationStatus, ["scheduled", "due-review"]),
    ));
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: settingKey(input.caseId),
      value: JSON.stringify(state),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(state), updatedAt: sql`now()` },
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "standard-operations",
      engine: "rules",
      hitlPattern: "human-review",
      ruleRef: "Start-date impact reconciliation",
      title: "Start date changed; reconciliation review required",
      detail: "HRIS, provisioning, payroll, benefits, and schedules require reconciliation. No provider action, release, or prior approval reuse occurred.",
      idempotencyKey: `standard-operations:${input.caseId}:start-date:${state.version}`,
    });
  });
  return getStandardOperationsView(input.organizationId, input.caseId);
}

type DateBoundSourceProof = {
  evidenceId: string;
  evidenceVersion: string;
  sourceStartDate: string;
  verifiedAt: string;
};

async function sourceProofForDateImpact(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    caseId: number;
    stream: StartDateImpactStream;
    expectedStartDate: string;
  },
): Promise<DateBoundSourceProof | null> {
  // Existing HRIS attestations, payroll checks, and IAM approvals have
  // provenance, but do not carry the provider-confirmed effective start date
  // plus an immutable source revision. They therefore cannot prove that a
  // post-change reconciliation occurred; accepting their timestamps would
  // incorrectly reuse pre-change evidence. Provider adapters must eventually
  // supply all four fields below from a source record before this branch can
  // return a proof. Until then this deliberately fails closed.
  void tx;
  void input;
  return null;
}

export async function reconcileStandardOperationsStartDateImpact(input: {
  organizationId: string;
  caseId: number;
  stream: StartDateImpactStream;
  resolution: "source-proof" | "manual-resolution";
  expectedVersion: number;
  actorUserId: string;
}): Promise<StandardOperationsView> {
  await db.transaction(async (tx) => {
    await lockMutableStandardOperationsCase(tx, input.organizationId, input.caseId);
    const [stored] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, settingKey(input.caseId)),
    )).for("update");
    const state = parseState(stored?.value ?? null);
    if (state.version !== input.expectedVersion) {
      throw new StandardOperationsConflictError(
        `Standard-operations holds changed since they were loaded (current version ${state.version}).`,
      );
    }
    if (!state.startDateReconciliation) {
      throw new StandardOperationsConflictError("No pending start-date reconciliation plan exists.");
    }
    if (state.startDateReconciliation.impacts[input.stream]) {
      throw new StandardOperationsConflictError(`The ${input.stream} impact was already reconciled; refresh before making another change.`);
    }
    const sourceProof = input.resolution === "source-proof"
      ? await sourceProofForDateImpact(tx, {
        ...input,
        expectedStartDate: state.startDateReconciliation.to,
      })
      : null;
    if (
      input.resolution === "source-proof" &&
      (!sourceProof ||
        sourceProof.sourceStartDate !== state.startDateReconciliation.to ||
        !sourceProof.evidenceId ||
        !sourceProof.evidenceVersion)
    ) {
      throw new StandardOperationsConflictError(
        `No date-bound source proof is currently available for ${input.stream}; use an accountable manual resolution until an authoritative adapter supplies the changed effective date and source revision.`,
      );
    }
    state.startDateReconciliation = {
      ...state.startDateReconciliation,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actorUserId,
      impacts: {
        ...state.startDateReconciliation.impacts,
        [input.stream]: {
          resolution: input.resolution,
          updatedAt: new Date().toISOString(),
          updatedBy: input.actorUserId,
          ...(sourceProof ? { sourceProof } : {}),
        },
      },
    };
    state.version += 1;
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: settingKey(input.caseId),
      value: JSON.stringify(state),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(state), updatedAt: sql`now()` },
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      agent: "standard-operations",
      engine: "rules",
      hitlPattern: "human-review",
      ruleRef: "Start-date impact reconciliation",
      title: `Start-date ${input.stream} reconciliation recorded`,
      detail: input.resolution === "source-proof"
        ? "A current server-verified source proof was recorded for this stream. This does not replace independent release evidence."
        : "An accountable manual stream resolution was recorded. This does not upgrade readiness or replace independent release evidence.",
      idempotencyKey: `standard-operations:${input.caseId}:start-date:${input.stream}:${state.version}`,
    });
  });
  return getStandardOperationsView(input.organizationId, input.caseId);
}
