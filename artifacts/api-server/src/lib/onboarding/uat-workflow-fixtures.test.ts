import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "./settings";
import { evaluateUatWorkflow } from "./uat-workflow-evaluator";
import { buildUatEvaluationFixturePlan } from "./uat-workflow-fixtures";

const baseCase = {
  organizationId: "fixture-organization",
  id: 71,
  workerEmail: "fixture.worker@example.invalid",
  joiningDate: "2030-01-01",
  checklistSnapshot: LEGACY_CHECKLIST.map((item) => ({ ...item })),
  readiness: readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({ ...item, status: "ready" as const })),
};

function run(scenarioId: string, states: string[] = []) {
  return {
    runId: `run-${scenarioId}`,
    scenarioId,
    clock: { now: "2028-01-01T00:00:00.000Z", offsetHours: 0 },
    exchanges: states.map((state, index) => ({
      id: `exchange-${index}`, at: "2028-01-01T00:00:00.000Z", system: "hris",
      operation: index === 0 ? "request" as const : "status" as const, state, note: "run-owned fixture",
    })),
  };
}

function decision(result: Awaited<ReturnType<typeof evaluateUatWorkflow>>, id: string) {
  const found = result.decisions.find((item) => item.id === id);
  assert.ok(found, `expected ${id} decision`);
  return found;
}

describe("UAT evaluation fixture collector plan", () => {
  test("selects a standard delayed fixture that drives the production standard and provider predicates", async () => {
    const plan = buildUatEvaluationFixturePlan(run("UAT-STD-01", ["request", "delayed"]) as any, baseCase);
    const result = await evaluateUatWorkflow({
      ...plan,
      uploads: { scannerResults: [{ runId: plan.runId, fixtureId: "fixture.txt", fixtureClass: "harmless-text", required: true, state: "pending" }] },
    });
    assert.equal(decision(result, "standard-release").observed, "blocked");
    assert.equal(decision(result, "standard-release").passed, true);
    assert.equal(decision(result, "oracle-observation").passed, true);
  });

  test("selects an authoritative frontline boundary result without claiming a synthetic release", async () => {
    const plan = buildUatEvaluationFixturePlan(
      run("UAT-FLT-01") as any,
      baseCase,
      { applicable: true, blockers: ["Current independently authorized safety evidence is required."] },
    );
    const result = await evaluateUatWorkflow({ ...plan, uploads: { scannerResults: [] } });
    const frontline = decision(result, "frontline-release");
    assert.equal(frontline.observed, "blocked");
    assert.equal(frontline.expected, "manual");
    assert.equal(frontline.passed, false);
  });

  test("selects duplicate transfer rows from an existing exchange state and uses transfer preview validation", async () => {
    const plan = buildUatEvaluationFixturePlan(run("UAT-XFR-01", ["duplicate"]) as any, baseCase);
    const result = await evaluateUatWorkflow({ ...plan, uploads: { scannerResults: [] } });
    const transfer = decision(result, "transfer-import");
    assert.equal(transfer.observed, "blocked");
    assert.equal(transfer.expected, "blocked");
    assert.equal(transfer.passed, true);
  });
});