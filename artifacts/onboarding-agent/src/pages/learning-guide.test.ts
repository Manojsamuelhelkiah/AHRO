import assert from "node:assert/strict";
import test from "node:test";
import type { OnboardingLearningCatalog } from "@workspace/api-client-react";
import { guideCoverageCsv, learningCoverageTotals, normalizeLearningCatalog, portableGuideText } from "./learning-guide";

test("learning guide transforms only canonical catalog content into traceable exports", () => {
  const catalog = normalizeLearningCatalog({
    catalogVersion: "test-catalog",
    baselineRevision: "BRD test baseline",
    scenarios: [],
    guideSections: [{
      id: "uat", title: "UAT Test Center", roles: ["QA coordinator"], entryPoints: ["/uat-test-center"],
      summary: "Use an isolated synthetic run.", instructions: ["Read expected evidence."], evidence: ["Run receipt"],
      exceptions: ["No provider certification."], featureIds: ["PFC-001"], scenarioIds: ["UAT-01"],
    }],
    features: [{ id: "PFC-001", name: "Test Center", roles: ["QA coordinator"], entryPoints: ["/uat-test-center"], scenarioIds: ["UAT-01"], verification: "manual" }],
    requirements: [{ id: "REQ-01", title: "Evidence", actor: "QA coordinator", sourceRefs: ["BRD 1"], scenarioIds: ["UAT-01"], availability: "partial", latestResult: "manual" }],
    denominators: { features: { denominator: 1 }, requirements: { denominator: 1 } },
  } as OnboardingLearningCatalog);
  assert.equal(catalog.guideSections.length, 1);
  assert.equal(catalog.guideSections[0].entryPoints[0], "/uat-test-center");
  const text = portableGuideText(catalog);
  assert.match(text, /Canonical catalog version: test-catalog/);
  assert.match(text, /No provider certification/);
  const csv = guideCoverageCsv(catalog);
  assert.match(csv, /record_type/);
  assert.match(csv, /"PFC-001"/);
  assert.match(csv, /"REQ-01"/);
  assert.deepEqual(learningCoverageTotals(catalog), {
    features: { denominator: 1, mapped: null },
    requirements: { denominator: 1, mapped: null },
  });
});

test("learning coverage totals use canonical denominators and scenario mappings", () => {
  const catalog = normalizeLearningCatalog({
    catalogVersion: "test-catalog",
    baselineRevision: "BRD test baseline",
    scenarios: [],
    guideSections: [],
    features: [],
    requirements: [],
    denominators: { features: { denominator: 44, withScenario: 44 }, requirements: { denominator: 81, withScenario: 80 } },
  } as OnboardingLearningCatalog);
  assert.deepEqual(learningCoverageTotals(catalog), {
    features: { denominator: 44, mapped: 44 },
    requirements: { denominator: 81, mapped: 80 },
  });
});