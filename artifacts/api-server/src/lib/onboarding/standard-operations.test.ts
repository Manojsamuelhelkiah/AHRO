import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateStandardOperations } from "./standard-operations";
import {
  approvedRehireReusePolicy,
  approvedStandardOperationsPolicy,
  parseManualFulfillmentBody,
} from "./standard-operations-schema";

const baseFacts = {
  standardNewHire: true,
  bgvApplicable: true,
  bgvClear: true,
  hrisActive: true,
  hrisSourceAuthoritative: true,
  currentAccessApproval: true,
  payrollCutoffKnown: true,
  rehire: false,
  validRehireSource: false,
  approvedRehireReusePolicy: false,
  approvedConditionalJoinPolicy: false,
  manualHolds: [],
} as const;

describe("standard operations safeguards", () => {
  test("does not release access or assets from simulated or incomplete evidence", () => {
    const view = evaluateStandardOperations({
      caseId: 7,
      startDate: "2030-01-01",
      state: { version: 0, exceptions: [] },
      facts: { ...baseFacts, bgvClear: false, hrisActive: false },
    });
    assert.equal(view.release.access.eligible, false);
    assert.equal(view.release.assets.eligible, false);
    assert.match(view.release.access.blockers.join(" "), /BGV.*trusted source/);
    assert.match(view.release.access.blockers.join(" "), /authoritative HRIS activation/);
    assert.equal(view.preparation.allowed, true);
  });

  test("requires both source evidence and approved policy for rehire reuse", () => {
    const view = evaluateStandardOperations({
      caseId: 7,
      startDate: "2030-01-01",
      state: { version: 0, exceptions: [] },
      facts: {
        ...baseFacts,
        rehire: true,
        validRehireSource: true,
        approvedRehireReusePolicy: false,
      },
    });
    assert.equal(view.rehireReuse.eligible, false);
  });

  test("keeps conditional join disabled without a policy receipt and holds cutoff/BGV exceptions", () => {
    const view = evaluateStandardOperations({
      caseId: 7,
      startDate: "2030-01-01",
      state: { version: 2, exceptions: [{ type: "no-response", state: "active", updatedAt: "2030-01-01T00:00:00.000Z", updatedBy: "u" }] },
      facts: {
        ...baseFacts,
        bgvClear: false,
        payrollCutoffKnown: false,
        manualHolds: ["no-response"],
      },
    });
    assert.equal(view.conditionalJoin.enabled, false);
    assert.deepEqual(view.exceptions.filter((entry) => entry.state === "held").map((entry) => entry.type),
      ["no-response", "payroll-cutoff", "delayed-bgv"]);
  });

  test("does not let one reconciled stream replace outstanding per-stream reconciliation", () => {
    const view = evaluateStandardOperations({
      caseId: 7,
      startDate: "2030-02-01",
      state: {
        version: 3,
        exceptions: [],
        startDateReconciliation: {
          from: "2030-01-01",
          to: "2030-02-01",
          updatedAt: "2030-01-02T00:00:00.000Z",
          updatedBy: "hr-1",
          impacts: {
            hris: {
              resolution: "source-proof",
              updatedAt: "2030-01-02T00:00:00.000Z",
              updatedBy: "hr-1",
            },
          },
        },
      },
      facts: baseFacts,
    });
    assert.equal(view.startDateReconciliation.state, "pending-review");
    assert.equal(view.release.access.eligible, false);
    assert.match(view.release.access.blockers.join(" "), /requires reconciliation for: provisioning, payroll, benefits, schedules/i);
  });

  test("clears only completed date-impact holds without upgrading independent live release evidence", () => {
    const impacts = Object.fromEntries(
      ["hris", "provisioning", "payroll", "benefits", "schedules"].map((stream) => [stream, {
        resolution: stream === "hris" ? "source-proof" : "manual-resolution",
        updatedAt: "2030-01-02T00:00:00.000Z",
        updatedBy: "owner-1",
      }]),
    ) as {
      hris: { resolution: "source-proof"; updatedAt: string; updatedBy: string };
      provisioning: { resolution: "manual-resolution"; updatedAt: string; updatedBy: string };
      payroll: { resolution: "manual-resolution"; updatedAt: string; updatedBy: string };
      benefits: { resolution: "manual-resolution"; updatedAt: string; updatedBy: string };
      schedules: { resolution: "manual-resolution"; updatedAt: string; updatedBy: string };
    };
    const completeView = evaluateStandardOperations({
      caseId: 7, startDate: "2030-02-01",
      state: { version: 8, exceptions: [], startDateReconciliation: {
        from: "2030-01-01", to: "2030-02-01", updatedAt: "2030-01-02T00:00:00.000Z", updatedBy: "owner-1", impacts,
      } },
      facts: baseFacts,
    });
    assert.equal(completeView.startDateReconciliation.state, "complete");
    assert.equal(completeView.release.access.eligible, true);
    const noLiveBgv = evaluateStandardOperations({
      caseId: 7, startDate: "2030-02-01",
      state: { version: 8, exceptions: [], startDateReconciliation: {
        from: "2030-01-01", to: "2030-02-01", updatedAt: "2030-01-02T00:00:00.000Z", updatedBy: "owner-1", impacts,
      } },
      facts: { ...baseFacts, bgvClear: false },
    });
    assert.equal(noLiveBgv.release.access.eligible, false);
  });

  test("accepts only explicit approved policy references", () => {
    assert.equal(approvedStandardOperationsPolicy({}, "conditionalJoin"), null);
    assert.equal(approvedStandardOperationsPolicy({
      standardOperations: {
        conditionalJoin: {
          status: "approved",
          policyReference: "POL-12",
          approvalReference: "APR-9",
        },
      },
    }, "conditionalJoin")?.policyReference, "POL-12");
    assert.equal(approvedRehireReusePolicy({
      standardOperations: {
        rehireReuse: {
          status: "approved",
          policyReference: "POL-12",
          approvalReference: "APR-9",
          sourceRecordId: 6,
          sourceEvidenceReference: "ARCHIVE-6",
        },
      },
    }, [5]), false);
    assert.equal(approvedRehireReusePolicy({
      standardOperations: {
        rehireReuse: {
          status: "approved",
          policyReference: "POL-12",
          approvalReference: "APR-9",
          sourceRecordId: 6,
          sourceEvidenceReference: "ARCHIVE-6",
        },
      },
    }, [6]), true);
    assert.equal(parseManualFulfillmentBody({
      area: "payroll", expectedVersion: 4, rationale: "Payroll owner reviewed the cutoff status.",
      status: "in-progress", evidenceStatus: "not-recorded", consentStatus: "not-applicable",
      cutoffStatus: "reviewed", reconciliationStatus: "pending", failureStatus: "none",
    }).cutoffStatus, "reviewed");
  });
});