import type {
  EffectDispatchClaim,
  EffectJournalIdentity,
} from "./effect-journal";
import { createHash } from "node:crypto";
import {
  normalizeOracleHcmObservation,
  normalizeServiceNowObservation,
  type NormalizedSourceObservation,
  type StandardProviderConfigurationState,
} from "./standard-provider-contracts";

/**
 * The transport is injected so adapters have no ambient network access and can
 * be exercised solely with fixtures. The production composition must supply an
 * authenticated server-side transport; browser inputs and mapping records can
 * never supply credentials.
 */
export type ProviderHttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

export type ProviderHttpResponse = {
  status: number;
  headers?: Record<string, string | undefined>;
  body: unknown;
};

export type ProviderHttpTransport = {
  request(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
};

export class StandardProviderAdapterError extends Error {
  constructor(
    readonly code:
      | "invalid-configuration"
      | "invalid-provider-response"
      | "remote-dispatch-blocked"
      | "remote-dispatch-failed"
      | "manual-repair-required"
      | "dispatch-in-progress",
    message: string,
  ) {
    super(message);
    this.name = "StandardProviderAdapterError";
  }
}

function cleanUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StandardProviderAdapterError("invalid-configuration", "Provider base URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new StandardProviderAdapterError("invalid-configuration", "Provider base URL must be a credential-free HTTPS origin/path.");
  }
  return url.toString().replace(/\/+$/, "");
}

function requiredMapping(mappings: Record<string, string>, key: string): string {
  const value = mappings[key]?.trim();
  if (!value) {
    throw new StandardProviderAdapterError("invalid-configuration", `Missing required provider field mapping: ${key}.`);
  }
  return value;
}

function readMappedString(record: unknown, path: string): string | null {
  const output = path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[part];
  }, record);
  return typeof output === "string" || typeof output === "number"
    ? String(output).trim() || null
    : null;
}

function calendarDate(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value.trim());
  if (!match || Number.isNaN(new Date(`${match[1]}T00:00:00.000Z`).getTime())) return null;
  return match[1];
}

function responseBodyResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const result = (body as Record<string, unknown>).result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : body as Record<string, unknown>;
}

function is2xx(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

export type OracleHcmAdapterConfig = {
  baseUrl: string;
  resourceVersion: string;
  fieldMappings: Record<string, string>;
  activeStatusValues: readonly string[];
};

export type OracleWorkRelationshipRead = {
  workersUniqId: string;
  periodOfServiceId: string;
  expectedCaseIdentity: string;
  expectedCaseStartDate: string;
  sourceObservedAt: Date;
  evidenceReference: string;
};

/**
 * Reads the Oracle-documented Work Relationships child resource. It is a read
 * adapter only: Oracle worker creation is intentionally not guessed from a
 * generic contract and remains outside this implementation.
 */
export async function readOracleHcmWorkRelationship(
  transport: ProviderHttpTransport,
  config: OracleHcmAdapterConfig,
  input: OracleWorkRelationshipRead,
): Promise<NormalizedSourceObservation> {
  const baseUrl = cleanUrl(config.baseUrl);
  if (!/^(latest|\d+(?:\.\d+){1,5})$/.test(config.resourceVersion)) {
    throw new StandardProviderAdapterError("invalid-configuration", "Oracle resourceVersion must be `latest` or a dotted API version.");
  }
  const response = await transport.request({
    method: "GET",
    url: `${baseUrl}/hcmRestApi/resources/${encodeURIComponent(config.resourceVersion)}/workers/${encodeURIComponent(input.workersUniqId)}/child/workRelationships/${encodeURIComponent(input.periodOfServiceId)}`,
    headers: { Accept: "application/json" },
  });
  if (!is2xx(response.status)) {
    throw new StandardProviderAdapterError("remote-dispatch-failed", `Oracle HCM read returned HTTP ${response.status}.`);
  }
  const body = responseBodyResult(response.body);
  const sourceRecordId = body && readMappedString(body, requiredMapping(config.fieldMappings, "workRelationshipId"));
  const status = body && readMappedString(body, requiredMapping(config.fieldMappings, "employmentStatus"));
  const caseIdentity = body && readMappedString(body, requiredMapping(config.fieldMappings, "caseIdentity"));
  if (!caseIdentity || caseIdentity.toLowerCase() !== input.expectedCaseIdentity.trim().toLowerCase()) {
    throw new StandardProviderAdapterError("invalid-provider-response", "Oracle HCM source record identity does not match the tenant-scoped case.");
  }
  const employmentStartDate = body && readMappedString(body, config.fieldMappings.employmentStartDate ?? "");
  // The opaque evidenceReference identifies this read occurrence; it is not a
  // source revision. A trusted activation must instead bind to an Oracle
  // record revision returned by the vendor (or its documented HTTP ETag).
  const sourceEvidenceRevision = response.headers?.etag?.trim()
    || (body && readMappedString(body, config.fieldMappings.sourceRevision ?? ""));
  const observation = normalizeOracleHcmObservation({
    recordType: "work-relationship",
    sourceRecordId,
    status,
    activeStatusValues: config.activeStatusValues,
    sourceObservedAt: input.sourceObservedAt.toISOString(),
    evidenceReference: input.evidenceReference,
    fieldSnapshot: body ? {
      workerId: readMappedString(body, requiredMapping(config.fieldMappings, "workerId")) ?? "",
      employeeNumber: readMappedString(body, requiredMapping(config.fieldMappings, "employeeNumber")) ?? "",
    } : {},
  });
  if (!observation) {
    throw new StandardProviderAdapterError("invalid-provider-response", "Oracle HCM response did not satisfy the configured identifier/status mapping.");
  }
  return {
    ...observation,
    verifiedCaseIdentity: caseIdentity,
    employmentStartDate: employmentStartDate && calendarDate(employmentStartDate) === calendarDate(input.expectedCaseStartDate)
      ? calendarDate(employmentStartDate)!
      : undefined,
    ...(sourceEvidenceRevision ? { sourceEvidenceRevision } : {}),
  };
}

/**
 * Oracle's Workers REST resource is the configured write target for a future
 * HRIS-created-worker flow. The payload intentionally stays tenant-specific:
 * this shared product does not invent legal entity, assignment, payroll, or
 * work-term values. It can only be called through the same effect boundary as
 * every other provider write.
 */
export async function submitOracleHcmWorker(input: Omit<JournaledRemoteWrite, "request" | "externalEffectId"> & {
  config: Pick<OracleHcmAdapterConfig, "baseUrl" | "resourceVersion">;
  workerPayload: Record<string, unknown>;
}): Promise<{ externalEffectId?: string; reusedConfirmed: boolean }> {
  const baseUrl = cleanUrl(input.config.baseUrl);
  if (!/^(latest|\d+(?:\.\d+){1,5})$/.test(input.config.resourceVersion)) {
    throw new StandardProviderAdapterError("invalid-configuration", "Oracle resourceVersion must be `latest` or a dotted API version.");
  }
  return executeJournaledRemoteWrite({
    ...input,
    request: {
      method: "POST",
      url: `${baseUrl}/hcmRestApi/resources/${encodeURIComponent(input.config.resourceVersion)}/workers`,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: input.workerPayload,
    },
    externalEffectId: (response) => {
      const body = responseBodyResult(response.body);
      return body && (
        readMappedString(body, "PersonId") ??
        readMappedString(body, "personId") ??
        readMappedString(body, "WorkerId")
      ) || undefined;
    },
  });
}

export type ServiceNowAdapterConfig = {
  baseUrl: string;
  requestTable: string;
  catalogItemSysId: string;
  fieldMappings: Record<string, string>;
  submittedStates: readonly string[];
  inProgressStates: readonly string[];
  fulfilledStates: readonly string[];
  failedStates: readonly string[];
};

export type ServiceNowRequestRead = {
  requestSysId: string;
  expectedCaseIdentity: string;
  sourceObservedAt: Date;
  evidenceReference: string;
};

/**
 * Reads a configured ServiceNow request table using the documented Table API.
 * Request table choice is tenant configuration because some instances model
 * request items (`sc_req_item`) rather than request headers (`sc_request`).
 */
export async function readServiceNowRequest(
  transport: ProviderHttpTransport,
  config: ServiceNowAdapterConfig,
  input: ServiceNowRequestRead,
): Promise<NormalizedSourceObservation> {
  const baseUrl = cleanUrl(config.baseUrl);
  const table = requiredMapping({ requestTable: config.requestTable }, "requestTable");
  const response = await transport.request({
    method: "GET",
    url: `${baseUrl}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(input.requestSysId)}`,
    headers: { Accept: "application/json" },
  });
  if (!is2xx(response.status)) {
    throw new StandardProviderAdapterError("remote-dispatch-failed", `ServiceNow request read returned HTTP ${response.status}.`);
  }
  const body = responseBodyResult(response.body);
  const sourceRecordId = body && readMappedString(body, requiredMapping(config.fieldMappings, "requestId"));
  const state = body && readMappedString(body, requiredMapping(config.fieldMappings, "requestState"));
  const caseIdentity = body && readMappedString(body, requiredMapping(config.fieldMappings, "caseIdentity"));
  if (!caseIdentity || caseIdentity.toLowerCase() !== input.expectedCaseIdentity.trim().toLowerCase()) {
    throw new StandardProviderAdapterError("invalid-provider-response", "ServiceNow source record identity does not match the tenant-scoped case.");
  }
  const observation = normalizeServiceNowObservation({
    sourceRecordId,
    state,
    submittedStates: config.submittedStates,
    inProgressStates: config.inProgressStates,
    fulfilledStates: config.fulfilledStates,
    failedStates: config.failedStates,
    sourceObservedAt: input.sourceObservedAt.toISOString(),
    evidenceReference: input.evidenceReference,
    fieldSnapshot: body ? {
      requestSysId: readMappedString(body, requiredMapping(config.fieldMappings, "requestSysId")) ?? "",
      requestedFor: readMappedString(body, requiredMapping(config.fieldMappings, "requestedFor")) ?? "",
    } : {},
  });
  if (!observation) {
    throw new StandardProviderAdapterError("invalid-provider-response", "ServiceNow response did not satisfy the configured request-state mapping.");
  }
  return observation;
}

export type RemoteDispatchActivation = {
  configurationState: StandardProviderConfigurationState;
  sandboxEvidenceReference: string | null;
  operatorApprovalReference: string | null;
  currentAuthorityApproved: boolean;
  protectedAuditHealthy: boolean;
  privacyPolicyApproved: boolean;
  workflowApprovalCurrent: boolean;
  /** Bound by the authority fence to the immutable payload sent below. */
  payloadFingerprint: string;
};

/**
 * This is the final activation predicate before the HTTP call. A record that
 * merely says operator-approved is insufficient. It also keeps this adapter
 * inactive while the existing source-observation route remains a manually
 * recorded status interface.
 */
export function assertRemoteDispatchActivation(activation: RemoteDispatchActivation): void {
  const blockers = [
    activation.configurationState !== "operator-approved" ? "configuration is not operator-approved" : null,
    !activation.sandboxEvidenceReference?.trim() ? "authenticated sandbox evidence is absent" : null,
    !activation.operatorApprovalReference?.trim() ? "operator approval reference is absent" : null,
    !activation.currentAuthorityApproved ? "current authority is not approved" : null,
    !activation.protectedAuditHealthy ? "protected audit health is not confirmed" : null,
    !activation.privacyPolicyApproved ? "privacy policy is not approved" : null,
    !activation.workflowApprovalCurrent ? "workflow approval is not current" : null,
    !activation.payloadFingerprint.startsWith("sha256:") ? "activation payload fingerprint is invalid" : null,
  ].filter((blocker): blocker is string => blocker !== null);
  if (blockers.length) {
    throw new StandardProviderAdapterError("remote-dispatch-blocked", `Remote dispatch blocked: ${blockers.join("; ")}.`);
  }
}

export type EffectJournalBoundary = {
  ensure(input: EffectJournalIdentity): Promise<{ fencingToken: number }>;
  claim(input: EffectJournalIdentity & {
    owner: string;
    expectedFencingToken: number;
  }): Promise<EffectDispatchClaim>;
  confirm(input: {
    logicalOperationKey: string;
    organizationId: string;
    owner: string;
    fencingToken: number;
    externalEffectId?: string;
  }): Promise<boolean>;
  rejectBeforeWrite(input: {
    logicalOperationKey: string;
    organizationId: string;
    owner: string;
    fencingToken: number;
    reason: string;
  }): Promise<boolean>;
  markAmbiguous(input: {
    logicalOperationKey: string;
    organizationId: string;
    owner: string;
    fencingToken: number;
    error: string;
  }): Promise<boolean>;
};

/**
 * Delayed import keeps contract fixtures wholly offline: only a production
 * caller that omits an injected test journal loads the database-backed journal.
 */
async function durableEffectJournalBoundary(): Promise<EffectJournalBoundary> {
  const journal = await import("./effect-journal");
  return {
    ensure: journal.ensureEffectJournalEntry,
    claim: journal.claimEffectDispatch,
    confirm: journal.confirmEffect,
    rejectBeforeWrite: journal.rejectEffectDispatchBeforeWrite,
    markAmbiguous: journal.markAmbiguousEffectForManualRepair,
  };
}

export type JournaledRemoteWrite = {
  identity: EffectJournalIdentity;
  owner: string;
  transport: ProviderHttpTransport;
  request: ProviderHttpRequest;
  externalEffectId: (response: ProviderHttpResponse) => string | undefined;
  /**
   * Mandatory production boundary. It must re-read current authority,
   * approval, audit, privacy, and provider configuration under its own
   * lifecycle/authority fence, then invoke the action with that fresh result.
   */
  withCurrentAuthorityFence: <T>(
    input: {
      identity: EffectJournalIdentity;
      payloadFingerprint: string;
    },
    action: (freshActivation: RemoteDispatchActivation) => Promise<T>,
  ) => Promise<T>;
  /**
   * A non-2xx result is ambiguous by default. Only a documented,
   * provider-specific contract may prove that a particular response means the
   * provider did not create an effect.
   */
  providerResponseProvesNoEffect?: (response: ProviderHttpResponse) => boolean;
  journal?: EffectJournalBoundary;
};

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StandardProviderAdapterError("invalid-configuration", "Provider payload contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  throw new StandardProviderAdapterError("invalid-configuration", "Provider payload must contain only JSON values.");
}

/** Stable payload binding for both the authority fence and effect journal. */
export function canonicalProviderPayloadFingerprint(body: Record<string, unknown> | undefined): string {
  return `sha256:${createHash("sha256").update(canonicalJson(body ?? {})).digest("hex")}`;
}

function immutableProviderRequest(request: ProviderHttpRequest): {
  request: ProviderHttpRequest;
  payloadFingerprint: string;
} {
  const canonicalPayload = canonicalJson(request.body ?? {});
  return {
    request: {
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: JSON.parse(canonicalPayload) as Record<string, unknown>,
    },
    payloadFingerprint: `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`,
  };
}

/**
 * Shared remote-write boundary for a future Oracle or ServiceNow fulfillment
 * operation. The stable logical operation key is given unchanged to the
 * provider as a correlation/idempotency key and is journal-fenced locally.
 * Provider idempotency is conservatively declared by the caller: if a vendor
 * cannot guarantee it, any ambiguous outcome is manual repair, never replay.
 */
/**
 * Fixture-only exercise point for the journal/ambiguity contract. Production
 * code must not inject an authority callback: no DB-backed production writer
 * has been composed yet.
 */
export async function executeJournaledRemoteWriteForTest(input: JournaledRemoteWrite): Promise<{
  externalEffectId?: string;
  reusedConfirmed: boolean;
}> {
  const immutable = immutableProviderRequest(input.request);
  if (input.identity.argumentsHash !== immutable.payloadFingerprint) {
    throw new StandardProviderAdapterError("invalid-configuration", "Effect journal argumentsHash must equal the canonical provider payload fingerprint.");
  }
  return input.withCurrentAuthorityFence({
    identity: input.identity,
    payloadFingerprint: immutable.payloadFingerprint,
  }, async (activation) => {
    assertRemoteDispatchActivation(activation);
    if (activation.payloadFingerprint !== immutable.payloadFingerprint) {
      throw new StandardProviderAdapterError("remote-dispatch-blocked", "Authority fence activation is stale for this provider payload.");
    }
    const journal = input.journal ?? await durableEffectJournalBoundary();
    const entry = await journal.ensure(input.identity);
    const claim = await journal.claim({
      ...input.identity,
      owner: input.owner,
      expectedFencingToken: entry.fencingToken,
    });
    if (claim.kind === "reuse_confirmed") {
      return { externalEffectId: claim.externalEffectId ?? undefined, reusedConfirmed: true };
    }
    if (claim.kind === "manual_repair_required") {
      throw new StandardProviderAdapterError("manual-repair-required", "Prior provider dispatch has an ambiguous outcome and requires manual reconciliation.");
    }
    if (claim.kind !== "claimed") {
      throw new StandardProviderAdapterError("dispatch-in-progress", "A provider effect is already being dispatched.");
    }
    const request = {
      ...immutable.request,
      headers: {
        ...immutable.request.headers,
        "Idempotency-Key": claim.providerIdempotencyKey,
        "X-Onboarding-Operation-Key": claim.providerIdempotencyKey,
      },
    };
    let providerMayHaveEffect = false;
    try {
      // A request can have reached the provider even when the client only sees
      // a timeout/socket error. Treat every dispatched request as ambiguous
      // until a provider-specific response contract proves otherwise.
      providerMayHaveEffect = true;
      const response = await input.transport.request(request);
      if (!is2xx(response.status)) {
        if (input.providerResponseProvesNoEffect?.(response) !== true) {
          throw new StandardProviderAdapterError("remote-dispatch-failed", `Provider returned ambiguous HTTP ${response.status}.`);
        }
        providerMayHaveEffect = false;
        await journal.rejectBeforeWrite({
          logicalOperationKey: input.identity.logicalOperationKey,
          organizationId: input.identity.organizationId,
          owner: input.owner,
          fencingToken: claim.fencingToken,
          reason: `Provider contract proved no effect for HTTP ${response.status}`,
        });
        throw new StandardProviderAdapterError("remote-dispatch-failed", `Provider returned HTTP ${response.status} without creating an effect.`);
      }
      const externalEffectId = input.externalEffectId(response)?.trim();
      if (!externalEffectId) {
        providerMayHaveEffect = true;
        throw new StandardProviderAdapterError("remote-dispatch-failed", "Provider success response omitted its required external effect ID.");
      }
      if (!(await journal.confirm({
      logicalOperationKey: input.identity.logicalOperationKey,
      organizationId: input.identity.organizationId,
      owner: input.owner,
      fencingToken: claim.fencingToken,
      externalEffectId,
    }))) {
        providerMayHaveEffect = true;
        throw new StandardProviderAdapterError("remote-dispatch-failed", "Provider accepted the request but journal confirmation was fenced.");
      }
      return { externalEffectId, reusedConfirmed: false };
    } catch (error) {
      if (!providerMayHaveEffect) throw error;
      if (input.identity.providerIdempotency) {
        throw new StandardProviderAdapterError("remote-dispatch-failed", `Provider outcome is ambiguous but the vendor idempotency contract permits journal-fenced retry: ${String(error).slice(0, 350)}`);
      }
      await journal.markAmbiguous({
      logicalOperationKey: input.identity.logicalOperationKey,
      organizationId: input.identity.organizationId,
      owner: input.owner,
      fencingToken: claim.fencingToken,
      error: String(error).slice(0, 500),
    });
      throw new StandardProviderAdapterError("manual-repair-required", `Provider outcome may have created an effect; manual reconciliation is required: ${String(error).slice(0, 350)}`);
    }
  });
}

/**
 * Production provider writes are deliberately unavailable. This fail-closed
 * boundary ensures a future route cannot accidentally make a remote mutation
 * by supplying a hand-rolled authority callback. A production implementation
 * must replace this with a non-injectable, database-backed authority and
 * lifecycle boundary before enabling either documented write adapter.
 */
export async function executeJournaledRemoteWrite(_input: JournaledRemoteWrite): Promise<never> {
  throw new StandardProviderAdapterError(
    "remote-dispatch-blocked",
    "Production provider writes are hard-disabled until a database-backed authority boundary is implemented.",
  );
}

/**
 * ServiceNow's documented Service Catalog API accepts an order_now request for
 * a configured catalog item. This adapter does not call it unless the caller
 * has independently passed the final activation and durable-journal boundary.
 */
export async function submitServiceNowCatalogRequest(input: Omit<JournaledRemoteWrite, "request" | "externalEffectId"> & {
  config: Pick<ServiceNowAdapterConfig, "baseUrl" | "catalogItemSysId">;
  variables: Record<string, unknown>;
}): Promise<{ externalEffectId?: string; reusedConfirmed: boolean }> {
  const baseUrl = cleanUrl(input.config.baseUrl);
  if (!input.config.catalogItemSysId.trim()) {
    throw new StandardProviderAdapterError("invalid-configuration", "A ServiceNow catalog item sys_id is required.");
  }
  return executeJournaledRemoteWrite({
    ...input,
    request: {
      method: "POST",
      url: `${baseUrl}/api/sn_sc/servicecatalog/items/${encodeURIComponent(input.config.catalogItemSysId)}/order_now`,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: { variables: input.variables },
    },
    externalEffectId: (response) => {
      const body = responseBodyResult(response.body);
      return body && (
        readMappedString(body, "request_id") ??
        readMappedString(body, "request.sys_id") ??
        readMappedString(body, "sys_id")
      ) || undefined;
    },
  });
}