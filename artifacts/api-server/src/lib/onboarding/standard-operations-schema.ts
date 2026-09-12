/**
 * This is deliberately a fixed-status schema rather than a free-form
 * operational narrative. Status projections can be shown to ordinary case
 * viewers without disclosing screening, payroll, or former-employment data.
 */
export const STANDARD_OPERATION_EXCEPTION_TYPES = [
  "no-response",
  "payroll-cutoff",
  "delayed-bgv",
] as const;

export type StandardOperationExceptionType =
  (typeof STANDARD_OPERATION_EXCEPTION_TYPES)[number];

export const START_DATE_IMPACT_STREAMS = [
  "hris",
  "provisioning",
  "payroll",
  "benefits",
  "schedules",
] as const;
export type StartDateImpactStream = (typeof START_DATE_IMPACT_STREAMS)[number];

export const MANUAL_FULFILLMENT_AREAS = ["bgv", "payroll", "benefits"] as const;
export type ManualFulfillmentArea = (typeof MANUAL_FULFILLMENT_AREAS)[number];
export const MANUAL_FULFILLMENT_STATUS = ["not-started", "in-progress", "failed", "resolved"] as const;
export const MANUAL_EVIDENCE_STATUS = ["not-recorded", "recorded"] as const;
export const MANUAL_CONSENT_STATUS = ["not-applicable", "pending", "recorded"] as const;
export const MANUAL_CUTOFF_STATUS = ["not-applicable", "unknown", "reviewed"] as const;
export const MANUAL_RECONCILIATION_STATUS = ["not-started", "pending", "resolved"] as const;
export const MANUAL_FAILURE_STATUS = ["none", "active"] as const;

export class StandardOperationsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandardOperationsValidationError";
  }
}

export function parseStandardOperationExceptionType(value: unknown): StandardOperationExceptionType {
  if (typeof value === "string" &&
    (STANDARD_OPERATION_EXCEPTION_TYPES as readonly string[]).includes(value)) {
    return value as StandardOperationExceptionType;
  }
  throw new StandardOperationsValidationError("A valid standard-operations exception type is required.");
}

function parseBody(value: unknown, requireType: boolean): {
  type?: StandardOperationExceptionType;
  expectedVersion: number;
  rationale: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StandardOperationsValidationError("A standard-operations request body is required.");
  }
  const body = value as Record<string, unknown>;
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    throw new StandardOperationsValidationError("expectedVersion must be a non-negative integer.");
  }
  if (typeof body.rationale !== "string" || body.rationale.trim().length < 3 || body.rationale.trim().length > 500) {
    throw new StandardOperationsValidationError("A 3–500 character rationale is required.");
  }
  return {
    ...(requireType ? { type: parseStandardOperationExceptionType(body.type) } : {}),
    expectedVersion: body.expectedVersion as number,
    rationale: body.rationale.trim(),
  };
}

export function parseSetStandardOperationExceptionBody(value: unknown): {
  type: StandardOperationExceptionType;
  expectedVersion: number;
  rationale: string;
} {
  return parseBody(value, true) as {
    type: StandardOperationExceptionType;
    expectedVersion: number;
    rationale: string;
  };
}

export function parseResolveStandardOperationExceptionBody(value: unknown): {
  expectedVersion: number;
  rationale: string;
} {
  return parseBody(value, false);
}

export function parseStandardOperationsStartDateBody(value: unknown): {
  startDate: string;
  expectedVersion: number;
  rationale: string;
} {
  const body = parseBody(value, false);
  const raw = value as Record<string, unknown>;
  if (typeof raw.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)) {
    throw new StandardOperationsValidationError("startDate must be a YYYY-MM-DD date.");
  }
  const [year, month, day] = raw.startDate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new StandardOperationsValidationError("startDate must be a valid calendar date.");
  }
  return { startDate: raw.startDate, ...body };
}

export function parseStartDateImpactReconciliationBody(value: unknown): {
  expectedVersion: number;
  rationale: string;
  resolution: "source-proof" | "manual-resolution";
} {
  const body = parseBody(value, false);
  const raw = value as Record<string, unknown>;
  if (raw.resolution !== "source-proof" && raw.resolution !== "manual-resolution") {
    throw new StandardOperationsValidationError("resolution must be source-proof or manual-resolution.");
  }
  return { ...body, resolution: raw.resolution };
}

export function parseStartDateImpactStream(value: unknown): StartDateImpactStream {
  if (typeof value === "string" && (START_DATE_IMPACT_STREAMS as readonly string[]).includes(value)) {
    return value as StartDateImpactStream;
  }
  throw new StandardOperationsValidationError("A valid start-date impact stream is required.");
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  throw new StandardOperationsValidationError(`${field} is invalid.`);
}

export function parseManualFulfillmentBody(value: unknown): {
  area: ManualFulfillmentArea;
  expectedVersion: number;
  rationale: string;
  status: typeof MANUAL_FULFILLMENT_STATUS[number];
  evidenceStatus: typeof MANUAL_EVIDENCE_STATUS[number];
  consentStatus: typeof MANUAL_CONSENT_STATUS[number];
  cutoffStatus: typeof MANUAL_CUTOFF_STATUS[number];
  reconciliationStatus: typeof MANUAL_RECONCILIATION_STATUS[number];
  failureStatus: typeof MANUAL_FAILURE_STATUS[number];
} {
  const body = parseBody(value, false);
  const raw = value as Record<string, unknown>;
  return {
    ...body,
    area: enumValue(raw.area, MANUAL_FULFILLMENT_AREAS, "area"),
    status: enumValue(raw.status, MANUAL_FULFILLMENT_STATUS, "status"),
    evidenceStatus: enumValue(raw.evidenceStatus, MANUAL_EVIDENCE_STATUS, "evidenceStatus"),
    consentStatus: enumValue(raw.consentStatus, MANUAL_CONSENT_STATUS, "consentStatus"),
    cutoffStatus: enumValue(raw.cutoffStatus, MANUAL_CUTOFF_STATUS, "cutoffStatus"),
    reconciliationStatus: enumValue(raw.reconciliationStatus, MANUAL_RECONCILIATION_STATUS, "reconciliationStatus"),
    failureStatus: enumValue(raw.failureStatus, MANUAL_FAILURE_STATUS, "failureStatus"),
  };
}

export type ApprovedStandardOperationsPolicy = {
  status: "approved";
  policyReference: string;
  approvalReference: string;
};

function isApprovedPolicy(value: unknown): value is ApprovedStandardOperationsPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.status === "approved" &&
    typeof candidate.policyReference === "string" &&
    candidate.policyReference.trim().length > 0 &&
    typeof candidate.approvalReference === "string" &&
    candidate.approvalReference.trim().length > 0;
}

/**
 * Extract only an explicit, immutable, case-snapshotted policy decision.
 * Labels, notes, generic approvals, and a browser-supplied claim are never
 * policy evidence. This intentionally supports no legacy fallback.
 */
export function approvedStandardOperationsPolicy(
  snapshot: Record<string, unknown>,
  key: "rehireReuse" | "conditionalJoin",
): ApprovedStandardOperationsPolicy | null {
  const root = snapshot.standardOperations;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const value = (root as Record<string, unknown>)[key];
  return isApprovedPolicy(value) ? value : null;
}

/**
 * A rehire policy receipt must bind to one of the server-read archive records.
 * A generic "rehire approved" label is not enough to reuse any prior
 * entitlement, schedule, asset, payroll, or benefit information.
 */
export function approvedRehireReusePolicy(
  snapshot: Record<string, unknown>,
  validSourceRecordIds: readonly number[],
): boolean {
  if (!approvedStandardOperationsPolicy(snapshot, "rehireReuse")) return false;
  const root = snapshot.standardOperations as Record<string, unknown>;
  const value = root.rehireReuse as Record<string, unknown>;
  const sourceRecordId = typeof value.sourceRecordId === "number"
    ? value.sourceRecordId
    : Number(value.sourceRecordId);
  return Number.isInteger(sourceRecordId) &&
    validSourceRecordIds.includes(sourceRecordId) &&
    typeof value.sourceEvidenceReference === "string" &&
    value.sourceEvidenceReference.trim().length > 0;
}