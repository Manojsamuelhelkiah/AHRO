import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeOracleHcmObservation,
  normalizeServiceNowObservation,
  ORACLE_HCM_WORK_RELATIONSHIP_FIXTURE,
  SERVICENOW_SERVICE_REQUEST_FIXTURE,
  STANDARD_PROVIDER_CONTRACTS,
  standardProviderLaunchBlockers,
} from "./standard-provider-contracts";

describe("standard provider contracts", () => {
  test("normalizes only a tenant-configured Oracle active status", () => {
    const active = normalizeOracleHcmObservation({
      recordType: "work-relationship",
      sourceRecordId: ORACLE_HCM_WORK_RELATIONSHIP_FIXTURE.PeriodOfServiceId,
      status: ORACLE_HCM_WORK_RELATIONSHIP_FIXTURE.AssignmentStatusType,
      activeStatusValues: ["ACTIVE"],
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      evidenceReference: "sandbox-receipt-1",
    });
    const inactive = normalizeOracleHcmObservation({
      recordType: "employee",
      sourceRecordId: "42",
      status: "ACTIVE",
      activeStatusValues: ["READY"],
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      evidenceReference: "sandbox-receipt-2",
    });
    assert.equal(active?.normalizedState, "work-relationship-active");
    assert.equal(inactive?.normalizedState, "employee-inactive");
  });

  test("rejects unknown ServiceNow state rather than treating it as fulfilled", () => {
    const accepted = normalizeServiceNowObservation({
      sourceRecordId: SERVICENOW_SERVICE_REQUEST_FIXTURE.number,
      state: SERVICENOW_SERVICE_REQUEST_FIXTURE.state,
      fulfilledStates: ["closed_complete"],
      submittedStates: ["requested"],
      inProgressStates: ["work_in_progress"],
      failedStates: ["closed_incomplete"],
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      evidenceReference: "snow-sandbox-1",
    });
    const unknown = normalizeServiceNowObservation({
      sourceRecordId: "RITM0010002",
      state: "mystery",
      fulfilledStates: ["closed_complete"],
      submittedStates: ["requested"],
      inProgressStates: ["work_in_progress"],
      failedStates: ["closed_incomplete"],
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      evidenceReference: "snow-sandbox-2",
    });
    assert.equal(accepted?.normalizedState, "request-fulfilled");
    assert.equal(unknown, null);
  });

  test("no contract can enable remote dispatch without a separate implementation", () => {
    const blockers = standardProviderLaunchBlockers({
      contract: STANDARD_PROVIDER_CONTRACTS["oracle-hcm"],
      configurationState: "operator-approved",
      sandboxEvidenceReference: "sandbox-1",
      operatorApprovalReference: "approval-1",
    });
    assert.deepEqual(blockers, ["No production remote dispatcher is implemented for this contract."]);
  });
});