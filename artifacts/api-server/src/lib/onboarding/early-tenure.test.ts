import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateEarlyTenurePolicy } from "./early-tenure";

const policy = {
  applicability: { hireTypes: ["external-fte"] },
  probationLengthDays: 120,
  decisionAuthorityScope: "hr-compliance-approve",
  obligations: [
    { key: "induction", kind: "induction", label: "Induction", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "compliance", kind: "compliance-training", label: "Compliance training", offsetDays: 7, required: true, ownerRole: "HR", requireEvidence: true },
    { key: "buddy", kind: "buddy-acknowledgement", label: "Buddy acknowledgement", offsetDays: 1, required: true, ownerRole: "manager", requireEvidence: true },
    { key: "manager", kind: "manager-connect", label: "Manager connect", offsetDays: 7, required: true, ownerRole: "manager", requireEvidence: true, structuredAgenda: ["expectations", "support"] },
    { key: "lms", kind: "learning-enrollment", label: "LMS enrollment", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true, connectorKey: "lms", sourceConfirmationRequired: true },
    { key: "calendar", kind: "calendar-delivery", label: "Calendar delivery", offsetDays: 0, required: true, ownerRole: "HR", requireEvidence: true },
  ],
  checkIns: [
    { key: "day-30", label: "30 day", offsetDays: 30, required: true, reminderLeadDays: 3 },
    { key: "day-60", label: "60 day", offsetDays: 60, required: true, reminderLeadDays: 3 },
    { key: "day-90", label: "90 day", offsetDays: 90, required: true, reminderLeadDays: 3 },
  ],
};

describe("early-tenure policy contract", () => {
  test("keeps legal probation separate from 30/60/90 cadence", () => {
    const parsed = validateEarlyTenurePolicy(policy);
    assert.equal(parsed.probationLengthDays, 120);
    assert.deepEqual(parsed.checkIns.map((item) => item.offsetDays), [30, 60, 90]);
  });

  test("allows a tenant-configured nonempty distinct check-in cadence", () => {
    const parsed = validateEarlyTenurePolicy({
      ...policy,
      checkIns: [
        { key: "week-2", label: "Two weeks", offsetDays: 14, required: true, reminderLeadDays: 2 },
        { key: "day-45", label: "45 day", offsetDays: 45, required: true, reminderLeadDays: 3 },
      ],
    });
    assert.deepEqual(parsed.checkIns.map((item) => item.offsetDays), [14, 45]);
  });

  test("requires separate learning enrollment and calendar delivery workflow tasks", () => {
    assert.throws(() => validateEarlyTenurePolicy({
      ...policy,
      obligations: policy.obligations.filter((item) => item.kind !== "learning-enrollment"),
    }), /learning-enrollment/);
    assert.throws(() => validateEarlyTenurePolicy({
      ...policy,
      obligations: policy.obligations.filter((item) => item.kind !== "calendar-delivery"),
    }), /calendar-delivery/);
  });

  test("requires a structured manager connect and a real source requirement", () => {
    assert.throws(() => validateEarlyTenurePolicy({
      ...policy,
      obligations: policy.obligations.map((item) => item.key === "manager" ? { ...item, structuredAgenda: [] } : item),
    }), /structuredAgenda/);
    assert.throws(() => validateEarlyTenurePolicy({
      ...policy,
      obligations: policy.obligations.map((item) => item.key === "lms" ? { ...item, connectorKey: undefined } : item),
    }), /connectorKey/);
  });

  test("rejects an implied ninety-day legal probation and unknown decision scope", () => {
    assert.throws(() => validateEarlyTenurePolicy({ ...policy, probationLengthDays: 0 }), /probationLengthDays/);
    assert.throws(() => validateEarlyTenurePolicy({ ...policy, decisionAuthorityScope: "made-up-scope" }), /decisionAuthorityScope/);
  });
});