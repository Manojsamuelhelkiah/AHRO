import { and, desc, eq } from "drizzle-orm";
import { onbCandidateUploads, onbCases, onbDocuments } from "@workspace/db";
import { latestRequiredUploadMalwareBlockers } from "./document-readiness-guard";
import { evaluateFrontlineFloorReadinessInTransaction } from "./frontline-operations";
import { isUatRunIsolatedCase } from "./synthetic-offline";
import type { OnboardingDbTransaction } from "./settings";
import type { UatRun } from "./uat-test-center";
import type {
  EvaluateUatWorkflowInput,
  ReadOnlyCandidateUploadObservation,
  UatFixtureExpectations,
  UatObservedOutcome,
  UatProviderFixture,
  UatRuntimeExchange,
  UatRunOwnedScannerResult,
  UatWorkflowFacts,
  UatWorkflowFamily,
} from "./uat-workflow-evaluator";

type CaseRow = typeof onbCases.$inferSelect;

type FixturePreset = {
  delayed: boolean;
  failed: boolean;
  identityMismatch: boolean;
  duplicate: boolean;
  quarantined: boolean;
  outOfOrder: boolean;
};

const FRONTLINE_POLICY_FIXTURE = Object.freeze({
  processPolicy: {
    frontline: {
      schemaVersion: "frontline-operations/v1",
      age: { minimumYears: 18 },
      fulfillment: { requiredItems: ["ppe"] },
      statutory: { requirements: [] },
      exceptions: {
        policyReference: "fixture:frontline-policy",
        reviewReference: "fixture:frontline-policy-review",
        permitted: [],
      },
    },
  },
});

function familyForScenario(scenarioId: string): UatWorkflowFamily {
  if (scenarioId === "UAT-FLT-01") return "frontline";
  if (scenarioId === "UAT-XFR-01") return "transfer";
  return scenarioId === "UAT-STD-01" ? "standard" : "shared";
}

/** Existing Test Center exchanges are the only selectable fixture controls.
 * No browser field can supply a provider response, scanner verdict, or live
 * upload status. */
function presetFromRun(run: Pick<UatRun, "exchanges">): FixturePreset {
  const states = run.exchanges.map((exchange) => exchange.state.trim().toLowerCase());
  const has = (...needles: string[]) => states.some((state) => needles.some((needle) => state.includes(needle)));
  return {
    delayed: has("delayed", "timeout", "pending"),
    failed: has("failed", "unavailable", "error"),
    identityMismatch: has("identity-mismatch", "identity mismatch"),
    duplicate: has("duplicate"),
    quarantined: has("quarantine", "infected"),
    outOfOrder: has("out-of-order", "out of order"),
  };
}

function outcome(value: boolean): UatObservedOutcome {
  return value ? "blocked" : "eligible";
}

function declaredExpectations(scenarioId: string, preset: FixturePreset): UatFixtureExpectations {
  const family = familyForScenario(scenarioId);
  const expectations: UatFixtureExpectations = {
    "exchange-order": outcome(preset.outOfOrder),
    checklist: "eligible",
    documents: outcome(preset.quarantined || preset.failed || preset.delayed),
  };
  if (family === "standard") {
    expectations["standard-release"] = outcome(preset.delayed || preset.failed);
    expectations["oracle-observation"] = outcome(preset.identityMismatch || preset.failed);
    expectations["servicenow-observation"] = outcome(preset.failed);
  }
  if (family === "frontline") {
    // A synthetic policy fixture cannot certify a live floor release. The
    // actual transaction-local boundary is still displayed as observed.
    expectations["frontline-release"] = "manual";
  }
  if (family === "transfer") {
    // Catalog policy intentionally requires specialist/legal evidence even
    // when the pure import preview is valid.
    expectations["transfer-import"] = preset.duplicate ? "blocked" : "manual";
  }
  return expectations;
}

function runtimeExchanges(run: Pick<UatRun, "exchanges" | "clock">, preset: FixturePreset): UatRuntimeExchange[] {
  const exchanges = run.exchanges.map((exchange, index): UatRuntimeExchange => {
    const action = exchange.operation === "request" || exchange.operation === "poll";
    return {
      id: exchange.id,
      sequence: index + 1,
      correlationId: `${exchange.system}:run-fixture`,
      kind: action ? "action" : "status-response",
      system: exchange.system,
      ...(action
        ? { action: { name: exchange.operation, target: exchange.system } }
        : { status: { state: exchange.state, receivedAt: exchange.at } }),
    };
  });
  if (preset.outOfOrder) {
    const status = exchanges.find((exchange) => exchange.kind === "status-response");
    if (status) status.sequence = 0;
    else exchanges.unshift({
      id: "fixture-out-of-order-status",
      sequence: 0,
      correlationId: "fixture:out-of-order",
      kind: "status-response",
      system: "fixture",
      status: { state: "out-of-order", receivedAt: run.clock.now },
    });
  }
  return exchanges;
}

function scannerResults(runId: string, preset: FixturePreset): UatRunOwnedScannerResult[] {
  return [{
    runId,
    fixtureId: "run-owned-harmless-document.txt",
    fixtureClass: "harmless-text",
    required: true,
    state: preset.quarantined ? "quarantined"
      : preset.failed ? "failed"
        : preset.delayed ? "pending"
          : "clean",
  }];
}

function providerFixtures(caseRow: Pick<CaseRow, "workerEmail" | "joiningDate">, run: Pick<UatRun, "runId" | "clock">, preset: FixturePreset): UatProviderFixture[] {
  const expectedIdentity = caseRow.workerEmail;
  const fixtureIdentity = preset.identityMismatch ? `mismatch-${expectedIdentity}` : expectedIdentity;
  const at = new Date(run.clock.now);
  return [
    {
      provider: "oracle-hcm",
      config: {
        baseUrl: "https://uat-fixture.oracle.example",
        resourceVersion: "latest",
        activeStatusValues: ["ACTIVE"],
        fieldMappings: {
          workerId: "PersonId", employeeNumber: "PersonNumber", workRelationshipId: "PeriodOfServiceId",
          employmentStatus: "AssignmentStatusType", caseIdentity: "WorkEmail", employmentStartDate: "StartDate",
          sourceRevision: "ObjectVersionNumber",
        },
      },
      input: {
        workersUniqId: "fixture-worker", periodOfServiceId: "fixture-period",
        expectedCaseIdentity: expectedIdentity, expectedCaseStartDate: caseRow.joiningDate,
        sourceObservedAt: at, evidenceReference: `fixture:${run.runId}:oracle`,
      },
      response: {
        status: preset.failed ? 503 : 200,
        headers: { etag: "fixture-revision-1" },
        body: {
          PersonId: "fixture-worker", PersonNumber: "fixture-person-number", PeriodOfServiceId: "fixture-period",
          AssignmentStatusType: "ACTIVE", WorkEmail: fixtureIdentity, StartDate: caseRow.joiningDate, ObjectVersionNumber: "1",
        },
      },
    },
    {
      provider: "servicenow",
      config: {
        baseUrl: "https://uat-fixture.servicenow.example",
        requestTable: "sc_req_item",
        catalogItemSysId: "fixture-catalog-item",
        fieldMappings: {
          requestId: "number", requestSysId: "sys_id", requestState: "state",
          requestedFor: "requested_for", caseIdentity: "requested_for.email",
        },
        submittedStates: ["requested"],
        inProgressStates: ["work_in_progress"],
        fulfilledStates: ["closed_complete"],
        failedStates: ["closed_incomplete"],
      },
      input: {
        requestSysId: "fixture-request", expectedCaseIdentity: expectedIdentity,
        sourceObservedAt: at, evidenceReference: `fixture:${run.runId}:servicenow`,
      },
      response: {
        status: preset.failed ? 503 : 200,
        body: {
          result: {
            number: "RITM-FIXTURE", sys_id: "fixture-request", state: "closed_complete",
            requested_for: { email: expectedIdentity },
          },
        },
      },
    },
  ];
}

function transferFixture(preset: FixturePreset) {
  const mapping = {
    sourceWorkerId: "sourceWorkerId", workerName: "workerName", workEmail: "workEmail",
    originalHireDate: "originalHireDate", continuousServiceDate: "continuousServiceDate",
    termsReference: "termsReference", compensationReference: "compensationReference", benefitsReference: "benefitsReference",
  };
  const row = {
    sourceWorkerId: "fixture-worker-1", workerName: "Fixture Worker", workEmail: "fixture.worker@example.invalid",
    originalHireDate: "2020-01-01", continuousServiceDate: "2020-01-01",
    termsReference: "fixture:terms", compensationReference: "fixture:compensation", benefitsReference: "fixture:benefits",
  };
  return { mapping, rows: preset.duplicate ? [row, { ...row, workerName: "Fixture Worker Duplicate" }] : [row] };
}

function standardFacts(preset: FixturePreset): UatWorkflowFacts["standard"] {
  const held = preset.delayed || preset.failed;
  return {
    startDate: "2030-01-01",
    state: { version: 0, exceptions: [] },
    facts: {
      standardNewHire: true, bgvApplicable: true, bgvClear: !held, hrisActive: !held,
      hrisSourceAuthoritative: !held, currentAccessApproval: !held, payrollCutoffKnown: !preset.delayed,
      rehire: false, validRehireSource: false, approvedRehireReusePolicy: false,
      approvedConditionalJoinPolicy: false, manualHolds: held ? ["no-response"] : [],
    },
  };
}

/**
 * Builds the non-database portion of a UAT evaluation input. It is used by
 * collectUatEvaluationInput below and is exported so callers/tests can inspect
 * the exact run-owned fixture selection before an evaluation.
 */
export function buildUatEvaluationFixturePlan(
  run: Pick<UatRun, "runId" | "scenarioId" | "exchanges" | "clock">,
  caseRow: Pick<CaseRow, "organizationId" | "id" | "workerEmail" | "joiningDate" | "checklistSnapshot" | "readiness">,
  frontlineBoundary: { applicable: boolean; blockers: readonly string[] } = { applicable: false, blockers: [] },
): Omit<EvaluateUatWorkflowInput, "uploads"> {
  const preset = presetFromRun(run);
  const family = familyForScenario(run.scenarioId);
  const facts: UatWorkflowFacts = { checklistStage: "before-day1-review" };
  if (family === "standard") facts.standard = standardFacts(preset);
  if (family === "frontline") facts.frontline = { policySnapshot: FRONTLINE_POLICY_FIXTURE, liveBoundary: frontlineBoundary };
  if (family === "transfer") facts.transfer = transferFixture(preset);
  return {
    runId: run.runId,
    scenario: { id: run.scenarioId, family, expected: declaredExpectations(run.scenarioId, preset) },
    providerMode: "simulated",
    caseContext: {
      organizationId: caseRow.organizationId, linkedCaseId: caseRow.id,
      checklistSnapshot: caseRow.checklistSnapshot, readiness: caseRow.readiness,
    },
    facts,
    exchanges: runtimeExchanges(run, preset),
    ...(family === "standard" ? { providerFixtures: providerFixtures(caseRow, run, preset) } : {}),
  };
}

function assertRunOwnsCase(run: UatRun, caseRow: CaseRow): void {
  if (
    !isUatRunIsolatedCase(caseRow) ||
    !run.linkedCaseIds.includes(caseRow.id) ||
    caseRow.scenarioKey !== run.scenarioId ||
    !caseRow.notes?.includes(`[uat-run:${run.runId}]`)
  ) {
    throw new Error("UAT evaluation may read only the run's durably linked isolated case.");
  }
}

function uploadStatus(state: typeof onbCandidateUploads.$inferSelect.malwareScanState): ReadOnlyCandidateUploadObservation["status"] {
  if (state === "clean") return "clean";
  if (state === "infected") return "quarantined";
  if (state === "unavailable") return "unavailable";
  if (state === "pending" || state === "scanning") return "pending";
  return "failed";
}

/**
 * Collect the complete evaluator input under a caller-owned transaction. It
 * reads (and snapshots) real candidate uploads only after strict durable run
 * ownership validation. The reader closure contains no database handle, so
 * evaluating its returned input cannot outlive a transaction and issue a
 * later database operation.
 */
export async function collectUatEvaluationInput(
  run: UatRun,
  caseRow: CaseRow,
  tx: OnboardingDbTransaction,
): Promise<EvaluateUatWorkflowInput> {
  assertRunOwnsCase(run, caseRow);
  let frontlineBoundary: { applicable: boolean; blockers: readonly string[] };
  try {
    frontlineBoundary = await evaluateFrontlineFloorReadinessInTransaction(tx, caseRow);
  } catch (error) {
    // A failed authoritative read is a block, never a fabricated floor
    // release. The evaluator will expose this as an observed boundary reason.
    frontlineBoundary = {
      applicable: true,
      blockers: [error instanceof Error ? `Authoritative frontline boundary unavailable: ${error.message}` : "Authoritative frontline boundary unavailable."],
    };
  }
  const plan = buildUatEvaluationFixturePlan(run, caseRow, frontlineBoundary);
  const latestRequiredUploadMalwareBlockerIds = await latestRequiredUploadMalwareBlockers(
    tx, caseRow.organizationId, caseRow.id,
  );
  const rows = await tx.select({
    uploadId: onbCandidateUploads.id,
    documentId: onbCandidateUploads.documentId,
    byteCount: onbCandidateUploads.sizeBytes,
    malwareScanState: onbCandidateUploads.malwareScanState,
    required: onbDocuments.required,
  }).from(onbCandidateUploads)
    .innerJoin(onbDocuments, and(
      eq(onbDocuments.organizationId, onbCandidateUploads.organizationId),
      eq(onbDocuments.caseId, onbCandidateUploads.caseId),
      eq(onbDocuments.id, onbCandidateUploads.documentId),
    ))
    .where(and(
      eq(onbCandidateUploads.organizationId, caseRow.organizationId),
      eq(onbCandidateUploads.caseId, caseRow.id),
    ))
    .orderBy(desc(onbCandidateUploads.id));
  const latestByDocument = new Set<number>();
  const uploads: ReadOnlyCandidateUploadObservation[] = [];
  for (const row of rows) {
    if (latestByDocument.has(row.documentId)) continue;
    latestByDocument.add(row.documentId);
    const status = uploadStatus(row.malwareScanState);
    uploads.push({
      uploadId: row.uploadId, documentId: row.documentId, byteCount: row.byteCount, status,
      quarantined: status === "quarantined", required: row.required,
    });
  }
  const ownership = {
    runId: run.runId, organizationId: caseRow.organizationId, caseId: caseRow.id,
  };
  return {
    ...plan,
    uploads: {
      scannerResults: scannerResults(run.runId, presetFromRun(run)),
      authorizer: {
        authorizeRunLinkedCase: async (candidate) =>
          candidate.runId === ownership.runId &&
          candidate.organizationId === ownership.organizationId &&
          candidate.caseId === ownership.caseId,
      },
      reader: {
        readLatestRequiredUploads: async (candidate) => {
          if (candidate.organizationId !== ownership.organizationId || candidate.caseId !== ownership.caseId) {
            throw new Error("Run-linked upload reader rejected a different case.");
          }
          return { latestRequiredUploadMalwareBlockerIds, uploads };
        },
      },
    },
  };
}