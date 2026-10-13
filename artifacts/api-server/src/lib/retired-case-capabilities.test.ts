import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isReadOnlyCaseExplanationRequest, isRetiredCaseCapabilityRequest, RetiredCaseCapabilityError, retiredCaseCapabilityResponse } from "./retired-case-capabilities";
import { isHistoricalTestRecord } from "./onboarding/historical-test-record";

test("read-only classification is exact, numeric, body-bearing, and never general POST permission", () => {
  assert.equal(isReadOnlyCaseExplanationRequest("POST", "/onboarding/cases/41/explain"), true);
  assert.equal(isReadOnlyCaseExplanationRequest("POST", "/ONBOARDING/CASES/41/EXPLAIN/"), true);
  for (const path of [
    "/onboarding/cases/0/explain", "/onboarding/cases/01/explain",
    "/onboarding/cases/1e3/explain", "/onboarding/cases/9007199254740992/explain",
    "/onboarding/cases/%34%31/explain", "/onboarding/cases/41/%65xplain",
    "/onboarding/cases/41/explain//", "/onboarding/cases/41/explain/execute",
    "/offboarding/cases/41/explain", "/onboarding/cases/41/explain?question=private",
  ]) assert.equal(isReadOnlyCaseExplanationRequest("POST", path), false, path);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
    assert.equal(isReadOnlyCaseExplanationRequest(method, "/onboarding/cases/41/explain"), false);
  }
});

test("all retired HTTP aliases are tombstoned while real operations remain routed", () => {
  for (const [method, path] of [
    ["GET", "/onboarding/scenarios"], ["POST", "/onboarding/scenarios/standard-fte/run"],
    ["GET", "/onboarding/synthetic-reset"], ["POST", "/onboarding/synthetic-reset"],
    ["POST", "/onboarding/demo/full-coverage"],
    ["POST", "/onboarding/cases/1/simulation/simulate-next"], ["POST", "/onboarding/cases/1/simulation/restart"],
    ["POST", "/onboarding/uat/runs"], ["POST", "/onboarding/uat/runs/old/actions"],
    ["GET", "/onboarding/uat/runs/old/fixture-pack"], ["POST", "/onboarding/uat/fairness/actions"],
    ["POST", "/policies/evaluation/review"], ["POST", "/policies/evaluation/runs"], ["POST", "/policies/evaluation/drift"],
    ["POST", "/onboarding/systems/email-watch/simulate"],
  ]) {
    assert.equal(isRetiredCaseCapabilityRequest(method, path), true, `${method} ${path}`);
    assert.equal(isRetiredCaseCapabilityRequest(method, `${path}/`), true, `${method} ${path}/`);
  }
  for (const [method, path] of [
    ["POST", "/onboarding/cases"], ["POST", "/onboarding/channels/test"],
    ["POST", "/onboarding/webhooks/twilio/voice-status"], ["POST", "/onboarding/webhooks/watcher-tick"],
    ["GET", "/onboarding/cases/1/simulation"], ["GET", "/onboarding/uat/runs/old/evidence-report"],
    ["GET", "/policies/evaluation"], ["POST", "/policies"],
    ["POST", "/scenarios"], ["GET", "/employee-vault"],
  ]) assert.equal(isRetiredCaseCapabilityRequest(method, path), false, `${method} ${path}`);
});

test("retirement response is consistent and never invokes next or effects", () => {
  let status = 0, body: unknown;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } };
  retiredCaseCapabilityResponse({} as any, response as any, () => assert.fail("must not fall through"));
  assert.equal(status, 410);
  assert.deepEqual(body, { code: "CASE_TEST_CAPABILITY_RETIRED", message: new RetiredCaseCapabilityError().message });
});

test("historical provenance survives minimized notes without trusting ordinary notes", () => {
  for (const syntheticProvenance of ["onboarding-demo-fictional", "synthetic-reset", "demo-full-coverage", "demo-controller-fictional"]) {
    assert.equal(isHistoricalTestRecord({ syntheticProvenance, notes: null }), true);
  }
  assert.equal(isHistoricalTestRecord({ scenarioKey: "UAT-STD-01", notes: null }), true);
  assert.equal(isHistoricalTestRecord({ scenarioKey: "standard-fte", notes: null }), true);
  assert.equal(isHistoricalTestRecord({ controllerRetired: true }), true);
  assert.equal(isHistoricalTestRecord({ notes: "[synthetic-offline-reset:v1]" }), false);
  assert.equal(isHistoricalTestRecord({ scenarioKey: null, syntheticProvenance: null }), false);
});

test("compatibility CLI exits before DB imports or seeding", () => {
  const source = readFileSync("src/scripts/seed-demo-full-coverage.ts", "utf8");
  assert.doesNotMatch(source, /^import /m);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CASE_TEST_CAPABILITY_RETIRED/);
});
