import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_TYPES, casesForList } from "../pages/cases/case-presentation";
import { operationalReportingPopulation } from "./operational-reporting";

const examples = CASE_TYPES.filter(family => family !== "All Cases").flatMap((family, familyIndex) =>
  Array.from({ length: 10 }, (_, slot) => ({
    id: 100 + familyIndex * 10 + slot,
    caseFamily: family, geography: `Example region ${familyIndex}`,
    hireType: "employee-service", status: "Blocked", orchestrationStatus: "blocked",
    controllerRetired: true, offlineSample: true, fictionalOfflineIdentity: true,
    gateways: { a: "pending", b: "blocked", c: "pending" },
  })),
);

test("all 120 authorized offline examples reconcile between ordinary lists and reporting totals", () => {
  assert.equal(examples.length, 120);
  assert.equal(casesForList(examples, false).length, 120);
  const approvals = examples.map(row => ({ caseId: row.id, status: "pending", agent: "Historical example" }));
  const population = operationalReportingPopulation(examples, approvals);
  assert.equal(population.cases.length, 120);
  assert.equal(population.approvals.length, 0);
  assert.equal(new Set(population.cases.map(row => row.caseFamily)).size, 12);
  assert.equal(new Set(population.cases.map(row => row.geography)).size, 12);
  assert.equal(population.cases.flatMap(row => Object.values(row.gateways)).length, 360);
  assert.equal(population.cases.filter(row => row.status === "Blocked").length, 120);
});

test("online plus offline cases add up while fixture approvals do not become current interventions", () => {
  const live = [
    { ...examples[0]!, id: 1, caseFamily: "Payroll", controllerRetired: false, offlineSample: false, status: "Completed" },
    { ...examples[1]!, id: 2, caseFamily: "Leave", controllerRetired: false, offlineSample: false, status: "In Progress" },
  ];
  const liveApprovals = [{ caseId: 2, status: "pending", agent: "Verified operator" }];
  const historicalApprovals = examples.map(row => ({ caseId: row.id, status: "pending", agent: "Example" }));
  const before = operationalReportingPopulation(live, liveApprovals);
  const after = operationalReportingPopulation([...live, ...examples], [...liveApprovals, ...historicalApprovals]);
  assert.equal(after.cases.length, before.cases.length + 120);
  assert.equal(after.cases.filter(row => row.status !== "Completed").length, 121);
  assert.equal(after.cases.filter(row => row.status === "Blocked").length, 120);
  assert.deepEqual(after.approvals, before.approvals);
  assert.ok(new Set(after.cases.map(row => row.caseFamily)).size >= 12);
});

test("offline status does not exclude counts; explicit exclusions and retained real history remain isolated", () => {
  const cases = [{ id: 1, offlineSample: true }, { id: 2, controllerRetired: true }, { id: 3 }];
  assert.deepEqual(operationalReportingPopulation(cases, [{ caseId: 1 }, { caseId: 2 }, { caseId: 3 }]),
    { cases: [cases[0], cases[2]], approvals: [{ caseId: 3 }] });
  assert.deepEqual(operationalReportingPopulation([
    { id: 4, offlineSample: true, reportingCaseEligible: false },
    { id: 5, controllerRetired: true, fictionalOfflineIdentity: true, reportingCaseEligible: true },
  ], []), { cases: [{ id: 5, controllerRetired: true, fictionalOfflineIdentity: true, reportingCaseEligible: true }], approvals: [] });
});
