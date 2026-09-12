/**
 * Client display contract for the server-side standard-provider adapters.
 * This browser module intentionally performs no provider I/O; production
 * transport remains server-only and activation-gated.
 */
export const STANDARD_PROVIDER_KEYS = [
  "oracle-hcm",
  "servicenow",
  "bgv",
  "payroll",
  "benefits",
] as const;

export type StandardProviderKey = typeof STANDARD_PROVIDER_KEYS[number];
export type StandardProviderConfigurationState =
  | "not-configured"
  | "mapping-configured"
  | "sandbox-validated"
  | "operator-approved";
export type StandardProviderEvidenceClass =
  | "operator-recorded-source-observation"
  | "sandbox-contract-fixture";
export type StandardProviderSourceRecordType =
  | "employee"
  | "work-relationship"
  | "service-request";

export type StandardProviderContract = {
  key: StandardProviderKey;
  label: string;
  sourceOfTruth: string;
  documentedApi: string | null;
  documentationUrl: string | null;
  defaultMappings: Record<string, string>;
  sourceRecordTypes: readonly StandardProviderSourceRecordType[];
  manualOwner: string;
  dispatchSupported: false;
  decisionRequirements: readonly string[];
  manualFulfillment: {
    status: "not-configured";
    evidence: string;
    consent: string;
    cutoff: string;
    reconciliation: string;
    failure: string;
  };
};

/**
 * Oracle endpoints are configured against the tenant's supported HCM REST
 * version. The official resource is documented as a workers child resource;
 * the mapping deliberately does not assume one customer's flexfields.
 */
export const STANDARD_PROVIDER_CONTRACTS: Record<
  StandardProviderKey,
  StandardProviderContract
> = {
  "oracle-hcm": {
    key: "oracle-hcm",
    label: "Oracle Fusion Cloud HCM",
    sourceOfTruth: "Core worker identity and active work relationship",
    documentedApi: "GET /hcmRestApi/resources/{version}/workers/{workersUniqID}/child/workRelationships/{PeriodOfServiceId}",
    documentationUrl: "https://docs.oracle.com/en/cloud/saas/human-resources/farws/api-workers-work-relationships.html",
    defaultMappings: {
      workerId: "PersonId",
      employeeNumber: "PersonNumber",
      workRelationshipId: "PeriodOfServiceId",
      employmentStatus: "AssignmentStatusType",
    },
    sourceRecordTypes: ["employee", "work-relationship"],
    manualOwner: "HRIS owner",
    dispatchSupported: false,
    decisionRequirements: [
      "Confirm the tenant HCM REST version and least-privilege integration role.",
      "Map the tenant's worker and work-relationship status fields; do not infer active employment from a display label.",
      "Record authenticated sandbox evidence before an operator can approve production configuration.",
    ],
    manualFulfillment: {
      status: "not-configured",
      evidence: "No worker source observation recorded.",
      consent: "Not applicable to source-status read contract.",
      cutoff: "Not applicable to source-status read contract.",
      reconciliation: "No source reconciliation is configured.",
      failure: "No production dispatch is activated.",
    },
  },
  servicenow: {
    key: "servicenow",
    label: "ServiceNow",
    sourceOfTruth: "IT service request and request-item state",
    documentedApi: "Service Catalog API item order endpoint and Table API request-state retrieval",
    documentationUrl: "https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html",
    defaultMappings: {
      requestId: "number",
      requestSysId: "sys_id",
      requestState: "state",
      requestedFor: "requested_for",
    },
    sourceRecordTypes: ["service-request"],
    manualOwner: "ITSM service owner",
    dispatchSupported: false,
    decisionRequirements: [
      "Confirm the catalog item, request/request-item table, terminal-state mapping, and ServiceNow release.",
      "Validate the least-privilege service account against sandbox before operator approval.",
      "Keep ServiceNow as source of truth for request state; this application only records normalized observations.",
    ],
    manualFulfillment: {
      status: "not-configured",
      evidence: "No service request source observation recorded.",
      consent: "Not applicable to service-request status read contract.",
      cutoff: "Not applicable to service-request status read contract.",
      reconciliation: "No source reconciliation is configured.",
      failure: "No production dispatch is activated.",
    },
  },
  bgv: {
    key: "bgv",
    label: "Background verification",
    sourceOfTruth: "Approved BGV vendor clearance record",
    documentedApi: null,
    documentationUrl: null,
    defaultMappings: {},
    sourceRecordTypes: [],
    manualOwner: "HR compliance / BGV owner",
    dispatchSupported: false,
    decisionRequirements: [
      "Select and approve a BGV vendor and jurisdiction-specific consent contract.",
      "Define clearance, adverse, no-response, evidence-retention, and escalation mappings.",
    ],
    manualFulfillment: {
      status: "not-configured",
      evidence: "Manual BGV owner must retain approved vendor clearance evidence.",
      consent: "Manual BGV owner must obtain and record applicable consent.",
      cutoff: "Not applicable; delayed/no-response escalation is manual.",
      reconciliation: "Manual BGV owner must reconcile vendor clearance state.",
      failure: "Manual owner must hold access/asset release and route the exception.",
    },
  },
  payroll: {
    key: "payroll",
    label: "Payroll",
    sourceOfTruth: "Approved payroll system enrollment and reconciliation record",
    documentedApi: null,
    documentationUrl: null,
    defaultMappings: {},
    sourceRecordTypes: [],
    manualOwner: "Payroll owner",
    dispatchSupported: false,
    decisionRequirements: [
      "Select an approved payroll provider and map eligibility, cutoff, enrollment, reconciliation, and failure states.",
      "Establish payroll authority and privacy controls before any production enrollment dispatch.",
    ],
    manualFulfillment: {
      status: "not-configured",
      evidence: "Payroll owner must retain approved enrollment evidence.",
      consent: "Payroll owner must confirm required employee consents/notices.",
      cutoff: "Payroll owner must confirm the applicable pay-cycle cutoff.",
      reconciliation: "Payroll owner must reconcile enrollment with the payroll system.",
      failure: "Payroll owner must use the manual repair and escalation workflow.",
    },
  },
  benefits: {
    key: "benefits",
    label: "Benefits",
    sourceOfTruth: "Approved benefits administrator enrollment and reconciliation record",
    documentedApi: null,
    documentationUrl: null,
    defaultMappings: {},
    sourceRecordTypes: [],
    manualOwner: "Benefits owner",
    dispatchSupported: false,
    decisionRequirements: [
      "Select an approved benefits administrator and eligibility/consent contract.",
      "Define enrollment cutoff, carrier reconciliation, evidence, and exception recovery mappings.",
    ],
    manualFulfillment: {
      status: "not-configured",
      evidence: "Benefits owner must retain approved enrollment evidence.",
      consent: "Benefits owner must confirm benefits election consent.",
      cutoff: "Benefits owner must confirm plan/carrier enrollment cutoff.",
      reconciliation: "Benefits owner must reconcile carrier and administrator records.",
      failure: "Benefits owner must use the manual repair and escalation workflow.",
    },
  },
};

export type NormalizedProviderSourceState =
  | "employee-active"
  | "employee-inactive"
  | "work-relationship-active"
  | "work-relationship-inactive"
  | "request-submitted"
  | "request-in-progress"
  | "request-fulfilled"
  | "request-failed";

/**
 * Shape-only fixtures derived from the documented resources. They are isolated
 * test data, contain no credentials or personal data, and must never be
 * mistaken for a successful sandbox receipt.
 */
export const ORACLE_HCM_WORK_RELATIONSHIP_FIXTURE = Object.freeze({
  PersonId: "fixture-person-id",
  PersonNumber: "fixture-employee-number",
  PeriodOfServiceId: "fixture-period-of-service-id",
  AssignmentStatusType: "ACTIVE",
});

export const SERVICENOW_SERVICE_REQUEST_FIXTURE = Object.freeze({
  number: "RITM0000001",
  sys_id: "fixture-service-request-sys-id",
  state: "closed_complete",
  requested_for: "fixture-requested-for-sys-id",
});

export type NormalizedSourceObservation = {
  providerKey: "oracle-hcm" | "servicenow";
  sourceRecordType: StandardProviderSourceRecordType;
  sourceRecordId: string;
  normalizedState: NormalizedProviderSourceState;
  sourceObservedAt: Date;
  evidenceReference: string;
  fieldSnapshot: Record<string, string>;
};

function nonBlank(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Oracle's tenant-specific assignment code mapping is intentionally supplied
 * by configuration; only the configured active values normalize to active.
 */
export function normalizeOracleHcmObservation(input: {
  recordType: "employee" | "work-relationship";
  sourceRecordId: unknown;
  status: unknown;
  activeStatusValues: readonly string[];
  sourceObservedAt: unknown;
  evidenceReference: unknown;
  fieldSnapshot?: unknown;
}): NormalizedSourceObservation | null {
  const sourceRecordId = nonBlank(input.sourceRecordId, 255);
  const status = nonBlank(input.status, 120);
  const sourceObservedAt = asDate(input.sourceObservedAt);
  const evidenceReference = nonBlank(input.evidenceReference, 500);
  if (!sourceRecordId || !status || !sourceObservedAt || !evidenceReference) return null;
  const active = input.activeStatusValues.some((value) =>
    value.trim().toLowerCase() === status.toLowerCase());
  return {
    providerKey: "oracle-hcm",
    sourceRecordType: input.recordType,
    sourceRecordId,
    normalizedState: input.recordType === "employee"
      ? active ? "employee-active" : "employee-inactive"
      : active ? "work-relationship-active" : "work-relationship-inactive",
    sourceObservedAt,
    evidenceReference,
    fieldSnapshot: stringRecord(input.fieldSnapshot),
  };
}

export function normalizeServiceNowObservation(input: {
  sourceRecordId: unknown;
  state: unknown;
  sourceObservedAt: unknown;
  evidenceReference: unknown;
  submittedStates: readonly string[];
  inProgressStates: readonly string[];
  fulfilledStates: readonly string[];
  failedStates: readonly string[];
  fieldSnapshot?: unknown;
}): NormalizedSourceObservation | null {
  const sourceRecordId = nonBlank(input.sourceRecordId, 255);
  const state = nonBlank(input.state, 120);
  const sourceObservedAt = asDate(input.sourceObservedAt);
  const evidenceReference = nonBlank(input.evidenceReference, 500);
  if (!sourceRecordId || !state || !sourceObservedAt || !evidenceReference) return null;
  const stateIn = (values: readonly string[]) => values.some((value) =>
    value.trim().toLowerCase() === state.toLowerCase());
  const normalizedState: NormalizedProviderSourceState | null =
    stateIn(input.submittedStates) ? "request-submitted"
      : stateIn(input.inProgressStates) ? "request-in-progress"
        : stateIn(input.fulfilledStates) ? "request-fulfilled"
          : stateIn(input.failedStates) ? "request-failed"
            : null;
  if (!normalizedState) return null;
  return {
    providerKey: "servicenow",
    sourceRecordType: "service-request",
    sourceRecordId,
    normalizedState,
    sourceObservedAt,
    evidenceReference,
    fieldSnapshot: stringRecord(input.fieldSnapshot),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .flatMap(([key, field]) => {
      const cleanKey = nonBlank(key, 120);
      const cleanValue = nonBlank(field, 500);
      return cleanKey && cleanValue ? [[cleanKey, cleanValue]] : [];
    }));
}

export function standardProviderLaunchBlockers(input: {
  contract: StandardProviderContract;
  configurationState: StandardProviderConfigurationState;
  sandboxEvidenceReference: string | null;
  operatorApprovalReference: string | null;
}): string[] {
  const blockers: string[] = [];
  if (!input.contract.dispatchSupported) {
    blockers.push("No production remote dispatcher is implemented for this contract.");
  }
  if (input.configurationState === "not-configured") {
    blockers.push("Provider mapping is not configured.");
  }
  if (!input.sandboxEvidenceReference?.trim()) {
    blockers.push("Authenticated sandbox validation evidence is required.");
  }
  if (!input.operatorApprovalReference?.trim()) {
    blockers.push("Explicit operator approval is required.");
  }
  return blockers;
}

/** A source observation is useful for planning/status, never a live access gate. */
export function observationCanSatisfyLiveReadiness(
  evidenceClass: StandardProviderEvidenceClass,
): false {
  void evidenceClass;
  return false;
}