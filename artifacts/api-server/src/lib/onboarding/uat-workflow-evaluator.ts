import type { OnbChecklistEnforcementStage, OnbChecklistTemplateItem, OnbReadinessItemRow } from "@workspace/db/schema";
import { checklistStageBlockers, readinessFromChecklist } from "./settings";
import { evaluateStandardOperations, type StandardOperationsFacts } from "./standard-operations";
import { parseFrontlinePolicy } from "./frontline-operations";
import { previewTransferRows } from "./workforce-transfer";
import {
  readOracleHcmWorkRelationship,
  readServiceNowRequest,
  type OracleHcmAdapterConfig,
  type OracleWorkRelationshipRead,
  type ProviderHttpResponse,
  type ProviderHttpTransport,
  type ServiceNowAdapterConfig,
  type ServiceNowRequestRead,
} from "./standard-provider-adapters";

/**
 * This evaluator is deliberately read-only.  A run controller can invoke it
 * after it has collected run-scoped facts, but it cannot create a readiness
 * item, source attestation, KPI, event, provider effect, or scan result.
 *
 * Expected outcomes are fixture declarations, not calculations.  Keeping them
 * separate from the production predicates below makes a fixture mismatch
 * visible rather than self-confirming.
 */
export type UatObservedOutcome = "eligible" | "blocked" | "manual";
export type UatExpectedOutcome = UatObservedOutcome;
export type UatWorkflowFamily = "standard" | "frontline" | "transfer" | "shared";

export type UatDecision = {
  id: string;
  label: string;
  family: UatWorkflowFamily;
  expected: UatExpectedOutcome;
  observed: UatObservedOutcome;
  /** Manual/unknown observations never count as a UAT pass. */
  passed: boolean;
  reasons: string[];
  ruleRefs: string[];
  provenance: string[];
};

export type UatFixtureExpectations = Partial<Record<
  | "exchange-order"
  | "checklist"
  | "documents"
  | "standard-release"
  | "frontline-release"
  | "transfer-import"
  | "oracle-observation"
  | "servicenow-observation",
  UatExpectedOutcome
>>;

export type UatRuntimeExchange = {
  id: string;
  sequence: number;
  correlationId: string;
  kind: "action" | "status-response";
  system: string;
  action?: { name: string; target: string };
  status?: { state: string; receivedAt: string };
};

export type UatRunOwnedScannerResult = {
  runId: string;
  fixtureId: string;
  /** Only harmless fixture scans may be injected in a simulated run. */
  fixtureClass: "harmless-text";
  state: "clean" | "pending" | "failed" | "quarantined";
  required: boolean;
};

/**
 * Authorization is intentionally a distinct injection from the reader.  The
 * production caller should bind the reader's blocker IDs to
 * latestRequiredUploadMalwareBlockers while it holds its ordinary case lock.
 * The evaluator never accepts a caller-supplied live upload status.
 */
export type RunLinkedCaseAuthorizer = {
  authorizeRunLinkedCase(input: {
    runId: string;
    organizationId: string;
    caseId: number;
  }): Promise<boolean>;
};

export type ReadOnlyCandidateUploadObservation = {
  uploadId: number;
  documentId: number;
  byteCount: number;
  status: "pending" | "clean" | "failed" | "quarantined" | "unavailable";
  quarantined: boolean;
  required: boolean;
};

export type RunLinkedCaseUploadReader = {
  readLatestRequiredUploads(input: {
    organizationId: string;
    caseId: number;
  }): Promise<{
    /** Authoritative result from latestRequiredUploadMalwareBlockers. */
    latestRequiredUploadMalwareBlockerIds: readonly number[];
    uploads: readonly ReadOnlyCandidateUploadObservation[];
  }>;
};

export type UatCaseContext = {
  organizationId: string;
  linkedCaseId: number;
  checklistSnapshot: OnbChecklistTemplateItem[];
  /** Omit only for a synthetic new-case fixture; pending rows are derived using
   * readinessFromChecklist, never written to the case. */
  readiness?: OnbReadinessItemRow[];
};

export type UatProviderFixture =
  | {
    provider: "oracle-hcm";
    config: OracleHcmAdapterConfig;
    input: OracleWorkRelationshipRead;
    response: ProviderHttpResponse;
  }
  | {
    provider: "servicenow";
    config: ServiceNowAdapterConfig;
    input: ServiceNowRequestRead;
    response: ProviderHttpResponse;
  };

export type UatWorkflowFacts = {
  checklistStage: OnbChecklistEnforcementStage;
  standard?: {
    startDate: string;
    facts: StandardOperationsFacts;
    /** The persisted state is intentionally a fixture projection only. */
    state: Parameters<typeof evaluateStandardOperations>[0]["state"];
  };
  frontline?: {
    /** Parsed by the production immutable-policy parser. */
    policySnapshot: Record<string, unknown>;
    /**
     * The actual Gate-C caller supplies its read-only result from
     * evaluateFrontlineFloorReadinessInTransaction.  Simulation fixtures may
     * use the same shape, but cannot claim that they released a worker.
     */
    liveBoundary: { applicable: boolean; blockers: readonly string[] };
  };
  transfer?: { mapping: unknown; rows: unknown };
};

export type EvaluateUatWorkflowInput = {
  runId: string;
  scenario: { id: string; family: UatWorkflowFamily; expected: UatFixtureExpectations };
  /** Provider execution is fixtures-only; any other mode is rejected. */
  providerMode: "simulated";
  caseContext: UatCaseContext;
  facts: UatWorkflowFacts;
  exchanges: readonly UatRuntimeExchange[];
  uploads: {
    scannerResults: readonly UatRunOwnedScannerResult[];
    authorizer?: RunLinkedCaseAuthorizer;
    reader?: RunLinkedCaseUploadReader;
  };
  providerFixtures?: readonly UatProviderFixture[];
};

export type UatWorkflowEvaluation = {
  runId: string;
  scenarioId: string;
  family: UatWorkflowFamily;
  providerMode: "simulated";
  decisions: UatDecision[];
  summary: { total: number; passed: number; failed: number; manual: number };
};

function expected(input: EvaluateUatWorkflowInput, id: keyof UatFixtureExpectations): UatExpectedOutcome {
  // An omitted assertion is deliberately not a pass assertion.
  return input.scenario.expected[id] ?? "manual";
}

function decision(
  input: EvaluateUatWorkflowInput,
  id: keyof UatFixtureExpectations,
  label: string,
  family: UatWorkflowFamily,
  observed: UatObservedOutcome,
  reasons: string[],
  ruleRefs: string[],
  provenance: string[],
): UatDecision {
  const asserted = expected(input, id);
  return {
    id,
    label,
    family,
    expected: asserted,
    observed,
    passed: asserted !== "manual" && asserted === observed,
    reasons,
    ruleRefs,
    provenance,
  };
}

function evaluateExchangeOrder(exchanges: readonly UatRuntimeExchange[]): { observed: UatObservedOutcome; reasons: string[] } {
  const actions = new Map<string, number>();
  const reasons: string[] = [];
  let prior = -1;
  for (const exchange of exchanges) {
    if (!Number.isSafeInteger(exchange.sequence) || exchange.sequence <= prior) {
      reasons.push(`Exchange "${exchange.id}" is not in a strictly increasing run sequence.`);
    }
    prior = exchange.sequence;
    if (exchange.kind === "action") {
      if (!exchange.action?.name || !exchange.action.target) reasons.push(`Action "${exchange.id}" lacks minimal coherent action data.`);
      else actions.set(exchange.correlationId, exchange.sequence);
    } else {
      const actionAt = actions.get(exchange.correlationId);
      if (!exchange.status?.state || !exchange.status.receivedAt) reasons.push(`Status response "${exchange.id}" lacks a state or receipt time.`);
      if (actionAt === undefined || actionAt >= exchange.sequence) {
        reasons.push(`Status response "${exchange.id}" arrived before its correlated action.`);
      }
    }
  }
  return { observed: reasons.length ? "blocked" : "eligible", reasons };
}

function fixtureTransport(response: ProviderHttpResponse): ProviderHttpTransport {
  return { request: async () => response };
}

async function evaluateProvider(
  input: EvaluateUatWorkflowInput,
  fixture: UatProviderFixture,
): Promise<UatDecision> {
  const id = fixture.provider === "oracle-hcm" ? "oracle-observation" : "servicenow-observation";
  try {
    const observation = fixture.provider === "oracle-hcm"
      ? await readOracleHcmWorkRelationship(fixtureTransport(fixture.response), fixture.config, fixture.input)
      : await readServiceNowRequest(fixtureTransport(fixture.response), fixture.config, fixture.input);
    const usable = fixture.provider === "oracle-hcm"
      ? observation.normalizedState === "work-relationship-active"
      : observation.normalizedState === "request-fulfilled";
    return decision(
      input, id, `${fixture.provider} fixture observation`, "standard",
      usable ? "eligible" : "blocked",
      usable ? [] : [`Normalized provider state is ${observation.normalizedState}.`],
      ["standard-provider-adapters.read-only", "standard-provider-contracts.normalizers"],
      ["simulated-provider-fixture", `normalized:${observation.providerKey}`],
    );
  } catch (error) {
    return decision(
      input, id, `${fixture.provider} fixture observation`, "standard", "blocked",
      [error instanceof Error ? error.message : "Provider fixture could not be normalized."],
      ["standard-provider-adapters.read-only", "standard-provider-contracts.normalizers"],
      ["simulated-provider-fixture"],
    );
  }
}

/**
 * Evaluate one synthetic UAT run.  All provider responses are served by an
 * in-memory injected transport; this function has no database or network
 * write path.  It is async only because a caller may make an authorized,
 * read-only inspection of a run-linked candidate case.
 */
export async function evaluateUatWorkflow(input: EvaluateUatWorkflowInput): Promise<UatWorkflowEvaluation> {
  if (input.providerMode !== "simulated") {
    throw new Error("UAT providerMode must be explicitly simulated.");
  }
  const decisions: UatDecision[] = [];
  const ordered = evaluateExchangeOrder(input.exchanges);
  decisions.push(decision(
    input, "exchange-order", "Run action/status ordering", "shared", ordered.observed, ordered.reasons,
    ["uat-run-exchange-order.v1"], ["run-owned-synthetic-exchanges"],
  ));

  const readiness = input.caseContext.readiness ?? readinessFromChecklist(input.caseContext.checklistSnapshot);
  const checklistBlockers = checklistStageBlockers(
    { checklistSnapshot: input.caseContext.checklistSnapshot, readiness },
    input.facts.checklistStage,
  );
  decisions.push(decision(
    input, "checklist", "Checklist stage gate", "shared",
    checklistBlockers.length ? "blocked" : "eligible",
    checklistBlockers.map((item) => item.label),
    ["settings.checklistStageBlockers", "settings.readinessFromChecklist"],
    [input.caseContext.readiness ? "synthetic-readiness-facts" : "synthetic-readiness-derived"],
  ));

  const invalidScannerFixtures = input.uploads.scannerResults.filter((result) =>
    result.runId !== input.runId || result.fixtureClass !== "harmless-text");
  const simulatedUploadBlockers = input.uploads.scannerResults.filter((result) =>
    result.runId === input.runId && result.fixtureClass === "harmless-text" && result.required && result.state !== "clean",
  );
  let authoritativeBlockers: readonly number[] = [];
  let uploadProvenance = ["run-owned-harmless-scanner-fixture"];
  const uploadReasons = [
    ...invalidScannerFixtures.map((result) => `Scanner result "${result.fixtureId}" is not a harmless fixture for this run.`),
    ...simulatedUploadBlockers.map((result) => `Required harmless fixture "${result.fixtureId}" is ${result.state}.`),
  ];
  if (input.uploads.authorizer || input.uploads.reader) {
    if (!input.uploads.authorizer || !input.uploads.reader) {
      uploadReasons.push("Run-linked candidate upload inspection requires both an authorizer and a read-only reader.");
    } else if (!await input.uploads.authorizer.authorizeRunLinkedCase({
      runId: input.runId, organizationId: input.caseContext.organizationId, caseId: input.caseContext.linkedCaseId,
    })) {
      uploadReasons.push("Run-linked candidate upload inspection was not authorized.");
    } else {
      const read = await input.uploads.reader.readLatestRequiredUploads({
        organizationId: input.caseContext.organizationId, caseId: input.caseContext.linkedCaseId,
      });
      authoritativeBlockers = read.latestRequiredUploadMalwareBlockerIds;
      uploadProvenance = [...uploadProvenance, "authorized-run-linked-case-read-only", "latestRequiredUploadMalwareBlockers"];
      // Preserve only validation-relevant observations; bytes/statuses are
      // inspected, never persisted or treated as a simulated scan result.
      for (const upload of read.uploads) {
        if (!Number.isSafeInteger(upload.byteCount) || upload.byteCount < 0) {
          uploadReasons.push(`Upload ${upload.uploadId} returned an invalid byte observation.`);
        }
        if (upload.required && (upload.quarantined || upload.status === "quarantined")) {
          uploadReasons.push(`Required upload ${upload.uploadId} is quarantined.`);
        }
      }
      if (authoritativeBlockers.length) {
        uploadReasons.push(`${authoritativeBlockers.length} latest required upload(s) are blocked by the authoritative malware gate.`);
      }
    }
  }
  const uploadManual = uploadReasons.some((reason) => reason.includes("requires both") || reason.includes("not authorized") || reason.includes("invalid byte"));
  decisions.push(decision(
    input, "documents", "Required document malware gate", "shared",
    uploadManual ? "manual" : uploadReasons.length ? "blocked" : "eligible",
    uploadReasons,
    ["document-readiness-guard.latestRequiredUploadMalwareBlockers"],
    uploadProvenance,
  ));

  if (input.facts.standard) {
    const view = evaluateStandardOperations({
      caseId: input.caseContext.linkedCaseId,
      startDate: input.facts.standard.startDate,
      state: input.facts.standard.state,
      facts: input.facts.standard.facts,
    });
    const blockers = [...view.release.access.blockers, ...view.release.assets.blockers];
    decisions.push(decision(
      input, "standard-release", "Standard access and asset release", "standard",
      blockers.length ? "blocked" : "eligible", blockers,
      ["standard-operations.evaluateStandardOperations"], ["synthetic-runtime-facts"],
    ));
  }

  if (input.facts.frontline) {
    try {
      parseFrontlinePolicy(input.facts.frontline.policySnapshot);
      const boundary = input.facts.frontline.liveBoundary;
      decisions.push(decision(
        input, "frontline-release", "Frontline floor release", "frontline",
        !boundary.applicable || boundary.blockers.length === 0 ? "eligible" : "blocked",
        [...boundary.blockers],
        ["frontline-operations.parseFrontlinePolicy", "frontline-operations.evaluateFrontlineFloorReadinessInTransaction"],
        ["synthetic-runtime-facts", "read-only-frontline-boundary"],
      ));
    } catch (error) {
      decisions.push(decision(
        input, "frontline-release", "Frontline floor release", "frontline", "manual",
        [error instanceof Error ? error.message : "Frontline policy cannot be evaluated."],
        ["frontline-operations.parseFrontlinePolicy"],
        ["synthetic-runtime-facts"],
      ));
    }
  }

  if (input.facts.transfer) {
    try {
      const preview = previewTransferRows(input.facts.transfer.mapping, input.facts.transfer.rows);
      decisions.push(decision(
        input, "transfer-import", "Transfer population import preview", "transfer",
        preview.errors.length ? "blocked" : "eligible",
        preview.errors.map((error) => `Row ${error.row} ${error.field}: ${error.message}`),
        ["workforce-transfer.previewTransferRows"], ["synthetic-runtime-facts"],
      ));
    } catch (error) {
      decisions.push(decision(
        input, "transfer-import", "Transfer population import preview", "transfer", "blocked",
        [error instanceof Error ? error.message : "Transfer preview failed."],
        ["workforce-transfer.previewTransferRows"], ["synthetic-runtime-facts"],
      ));
    }
  }

  for (const providerFixture of input.providerFixtures ?? []) {
    decisions.push(await evaluateProvider(input, providerFixture));
  }
  // A scenario author can declare a target before the runtime collector is
  // implemented. Do not silently omit that control from the report: surface a
  // manual gap instead, and never turn the fixture declaration into a pass.
  const labels: Record<keyof UatFixtureExpectations, { label: string; family: UatWorkflowFamily }> = {
    "exchange-order": { label: "Run action/status ordering", family: "shared" },
    checklist: { label: "Checklist stage gate", family: "shared" },
    documents: { label: "Required document malware gate", family: "shared" },
    "standard-release": { label: "Standard access and asset release", family: "standard" },
    "frontline-release": { label: "Frontline floor release", family: "frontline" },
    "transfer-import": { label: "Transfer population import preview", family: "transfer" },
    "oracle-observation": { label: "oracle-hcm fixture observation", family: "standard" },
    "servicenow-observation": { label: "servicenow fixture observation", family: "standard" },
  };
  for (const id of Object.keys(input.scenario.expected) as Array<keyof UatFixtureExpectations>) {
    if (!decisions.some((item) => item.id === id)) {
      decisions.push(decision(
        input, id, labels[id].label, labels[id].family, "manual",
        ["The scenario declares an expectation but supplied no runtime fact or simulated provider fixture."],
        ["uat-workflow-evaluator.missing-runtime-fact"],
        ["manual-collection-required"],
      ));
    }
  }
  return {
    runId: input.runId,
    scenarioId: input.scenario.id,
    family: input.scenario.family,
    providerMode: "simulated",
    decisions,
    summary: {
      total: decisions.length,
      passed: decisions.filter((item) => item.passed).length,
      failed: decisions.filter((item) => !item.passed && item.observed !== "manual").length,
      manual: decisions.filter((item) => item.observed === "manual").length,
    },
  };
}