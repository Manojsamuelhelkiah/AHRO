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

test("the full 120-example inventory stays in ordinary lists but contributes no operational population or denominators", () => {
  assert.equal(examples.length, 120);
  assert.equal(casesForList(examples, false).length, 120);
  const approvals = examples.map(row => ({ caseId: row.id, status: "pending", agent: "Historical example" }));
  const population = operationalReportingPopulation(examples, approvals);
  assert.equal(population.cases.length, 0);
  assert.equal(population.approvals.length, 0);
  assert.equal(new Set(population.cases.map(row => row.caseFamily)).size, 0);
  assert.equal(new Set(population.cases.map(row => row.geography)).size, 0);
  assert.equal(population.cases.flatMap(row => Object.values(row.gateways)).length, 0);
  // Dashboard and Analytics derive their totals, rates, choices and readiness
  // summaries from this shared empty population, not the 120 visible rows.
});

test("operational totals and intervention denominators stay unchanged after adding all 120 blocked examples", () => {
  const live = [
    { ...examples[0]!, id: 1, caseFamily: "Payroll", controllerRetired: false, offlineSample: false, status: "Completed" },
    { ...examples[1]!, id: 2, caseFamily: "Leave", controllerRetired: false, offlineSample: false, status: "In Progress" },
  ];
  const liveApprovals = [{ caseId: 2, status: "pending", agent: "Verified operator" }];
  const historicalApprovals = examples.map(row => ({ caseId: row.id, status: "pending", agent: "Example" }));
  const before = operationalReportingPopulation(live, liveApprovals);
  const after = operationalReportingPopulation([...live, ...examples], [...liveApprovals, ...historicalApprovals]);
  assert.deepEqual(after, before);
  assert.equal(after.cases.filter(row => row.status !== "Completed").length, 1);
  assert.equal(after.cases.filter(row => row.status === "Blocked").length, 0);
  assert.equal(after.approvals.length / after.cases.length, 0.5);
  assert.deepEqual([...new Set(after.cases.map(row => row.caseFamily))], ["Payroll", "Leave"]);
});

test("either offline or retired flag independently excludes a row and its approvals", () => {
  const cases = [{ id: 1, offlineSample: true }, { id: 2, controllerRetired: true }, { id: 3 }];
  assert.deepEqual(operationalReportingPopulation(cases, [{ caseId: 1 }, { caseId: 2 }, { caseId: 3 }]),
    { cases: [cases[2]], approvals: [{ caseId: 3 }] });
});
