import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

test("retained acceptance history cannot restore retired fixture or progression controls", () => {
  const source = readFileSync(path.resolve("src/pages/uat-test-center.tsx"), "utf8");
  assert.match(source, /Acceptance history/);
  assert.match(source, /read-only and non-operational/);
  assert.match(source, /do not establish approval authority, live readiness, or business outcomes/);
  assert.match(source, /Current workspace admission and record access are required/);
  assert.match(source, /EvidenceDownload/);
  assert.doesNotMatch(source, /syntheticPdf|syntheticFixturePayload|createUatRun|advance-clock|applyUatAction/);
});

test("UAT admission copy preserves testing and non-certification boundaries", () => {
  const source = readFileSync(path.resolve("src/pages/login.tsx"), "utf8");
  assert.match(source, /Test runs/);
  assert.match(source, /not certification|not a certification/i);
  assert.doesNotMatch(source, /Synthetic runs|fictional benchmark|simulated case/i);
});
