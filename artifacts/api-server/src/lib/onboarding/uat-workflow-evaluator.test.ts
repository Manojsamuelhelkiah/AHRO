import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "./settings";
import { evaluateUatWorkflow, type EvaluateUatWorkflowInput } from "./uat-workflow-evaluator";
import type { OracleHcmAdapterConfig } from "./standard-provider-adapters";

const runId = "uat-run-fixture";
const oracleConfig: OracleHcmAdapterConfig = {
  baseUrl: "https://oracle.example.test",
  resourceVersion: "latest",
  activeStatusValues: ["ACTIVE"],
  fieldMappings: {
    workerId: "PersonId", employeeNumber: "PersonNumber", workRelationshipId: "PeriodOfServiceId",
    employmentStatus: "AssignmentStatusType", caseIdentity: "WorkEmail", employmentStartDate: "StartDate",
  },
};

function input(overrides: Partial<EvaluateUatWorkflowInput> = {}): EvaluateUatWorkflowInput {
  return {
    runId,
    providerMode: "simulated",
    scenario: {
      id: "UAT-evaluator", family: "shared",
      expected: { "exchange-order": "eligible", checklist: "eligible", documents: "eligible" },
    },
    caseContext: {
      organizationId: "uat-organization", linkedCaseId: 42, checklistSnapshot: LEGACY_CHECKLIST.map((item) => ({ ...item })),
      readiness: readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({ ...item, status: "ready" as const })),
    },
    facts: { checklistStage: "before-day1-review" },
    exchanges: [{
      id: "request-1", sequence: 1, correlationId: "request-1", kind: "action", system: "hris",
      action: { name: "read-status", target: "oracle-hcm" },
    }, {
      id: "response-1", sequence: 2, correlationId: "request-1", kind: "status-response", system: "hris",
      status: { state: "complete", receivedAt: "2025-01-01T00:00:00.000Z" },
    }],
    uploads: { scannerResults: [{ runId, fixtureId: "harmless-id.txt", fixtureClass: "harmless-text", state: "clean", required: true }] },
    ...overrides,
  };
}

function byId(result: Awaited<ReturnType<typeof evaluateUatWorkflow>>, id: string) {
  const found = result.decisions.find((item) => item.id === id);
  assert.ok(found, `decision ${id} exists`);
  return found;
}

describe("evaluateUatWorkflow", () => {
  test("uses the real Oracle adapter/normalizer and flags an identity mismatch", async () => {
    const result = await evaluateUatWorkflow(input({
      scenario: {
        id: "UAT-standard-provider-mismatch", family: "standard",
        expected: { "exchange-order": "eligible", checklist: "eligible", documents: "eligible", "oracle-observation": "blocked" },
      },
      providerFixtures: [{
        provider: "oracle-hcm", config: oracleConfig,
        input: {
          workersUniqId: "worker-1", periodOfServiceId: "period-1", expectedCaseIdentity: "avery@example.invalid",
          expectedCaseStartDate: "2025-01-01", sourceObservedAt: new Date("2025-01-01T00:00:00.000Z"), evidenceReference: "fixture:oracle-1",
        },
        response: {
          status: 200,
          body: {
            PersonId: "person-1", PersonNumber: "E-1", PeriodOfServiceId: "period-1",
            AssignmentStatusType: "ACTIVE", WorkEmail: "different@example.invalid", StartDate: "2025-01-01",
          },
        },
      }],
    }));
    const oracle = byId(result, "oracle-observation");
    assert.equal(oracle.observed, "blocked");
    assert.equal(oracle.passed, true);
    assert.match(oracle.reasons.join(" "), /identity does not match/i);
  });

  test("uses transfer preview validation to block duplicate stable identities", async () => {
    const row = {
      source: "worker-1", name: "Avery Example", email: "avery@example.invalid", hire: "2020-01-01",
      service: "2020-01-01", terms: "terms-ref", compensation: "comp-ref", benefits: "benefits-ref",
    };
    const result = await evaluateUatWorkflow(input({
      scenario: {
        id: "UAT-transfer-duplicate", family: "transfer",
        expected: { "exchange-order": "eligible", checklist: "eligible", documents: "eligible", "transfer-import": "blocked" },
      },
      facts: {
        checklistStage: "before-day1-review",
        transfer: {
          mapping: {
            sourceWorkerId: "source", workerName: "name", workEmail: "email", originalHireDate: "hire",
            continuousServiceDate: "service", termsReference: "terms", compensationReference: "compensation", benefitsReference: "benefits",
          },
          rows: [row, { ...row, name: "Avery Duplicate" }],
        },
      },
    }));
    const transfer = byId(result, "transfer-import");
    assert.equal(transfer.observed, "blocked");
    assert.equal(transfer.passed, true);
    assert.match(transfer.reasons.join(" "), /duplicate stable sourceWorkerId/i);
  });

  test("blocks out-of-order status responses and quarantined required fixtures without writing case state", async () => {
    const result = await evaluateUatWorkflow(input({
      scenario: {
        id: "UAT-quarantine-order", family: "frontline",
        expected: {
          "exchange-order": "blocked", checklist: "eligible", documents: "blocked", "frontline-release": "blocked",
        },
      },
      facts: {
        checklistStage: "before-day1-review",
        frontline: {
          policySnapshot: {
            processPolicy: {
              frontline: {
                schemaVersion: "frontline-operations/v1",
                age: { minimumYears: 18 },
                fulfillment: { requiredItems: ["ppe"] },
                statutory: { requirements: [] },
                exceptions: { policyReference: "policy:frontline", reviewReference: "review:frontline", permitted: [] },
              },
            },
          },
          liveBoundary: { applicable: true, blockers: ["Physical PPE issuance is incomplete."] },
        },
      },
      exchanges: [{
        id: "response-first", sequence: 1, correlationId: "late-action", kind: "status-response", system: "itsm",
        status: { state: "fulfilled", receivedAt: "2025-01-01T00:00:00.000Z" },
      }],
      uploads: {
        scannerResults: [{
          runId, fixtureId: "harmless-quarantined.txt", fixtureClass: "harmless-text", state: "quarantined", required: true,
        }],
      },
    }));
    assert.equal(byId(result, "exchange-order").passed, true);
    const documents = byId(result, "documents");
    assert.equal(documents.observed, "blocked");
    assert.equal(documents.passed, true);
    assert.match(documents.reasons.join(" "), /quarantined/i);
    assert.equal(byId(result, "frontline-release").passed, true);
  });
});