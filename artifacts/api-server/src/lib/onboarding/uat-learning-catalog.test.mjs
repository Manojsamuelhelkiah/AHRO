import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../../../..");
const bundle = resolve(root, ".cache/uat-learning-catalog.test.bundle.mjs");
execFileSync(resolve(root, "artifacts/api-server/node_modules/.bin/esbuild"), [
  "artifacts/api-server/src/lib/onboarding/uat-learning-catalog.ts", "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${bundle}`,
], { cwd: root, stdio: "inherit" });
const catalog = await import(`${pathToFileURL(bundle).href}?test=1`);

assert.deepEqual(catalog.inventoryConsistencyIssues(), [], "Every feature, guide topic and requirement must have resolvable traceability.");
assert.ok(catalog.UAT_SCENARIOS.some((item) => item.id === "UAT-STD-01"), "Original standard scenario ID must remain stable.");
assert.ok(catalog.UAT_SCENARIOS.some((item) => item.id === "UAT-FLT-01"), "Original frontline scenario ID must remain stable.");
assert.ok(catalog.UAT_SCENARIOS.some((item) => item.id === "UAT-XFR-01"), "Original transfer scenario ID must remain stable.");
assert.ok(catalog.REQUIREMENTS.some((item) => item.id === "APP-A-22"), "Frontline appendix obligations must be present.");
assert.ok(catalog.REQUIREMENTS.some((item) => item.id === "APP-B-12"), "Transfer appendix obligations must be present.");
assert.ok(catalog.REQUIREMENTS.some((item) => item.id === "BR-08"), "Business rules must be separately traceable.");
assert.equal(catalog.FEATURE_COVERAGE.referenceMapped, catalog.FEATURE_COVERAGE.denominator, "Feature reference coverage must be explicit and complete.");
assert.equal(catalog.FEATURE_COVERAGE.executedAssertions, 0, "The static catalog must not claim executed feature assertions.");
assert.equal(catalog.REQUIREMENT_COVERAGE.executedAssertions, 0, "The static catalog must not claim executed requirement assertions.");
assert.ok(catalog.UAT_SCENARIOS.filter((item) => item.mode === "simulated").every((item) => item.prerequisites?.[0].includes("Test Center") && item.prerequisites?.[0].includes("run-owned")), "Simulated scenarios must stay inside Test Center run-owned links/evaluator.");
const documentScenario = catalog.UAT_SCENARIOS.find((item) => item.id === "UAT-DOC-01");
assert.match(documentScenario.steps[0].expected, /input, not an auto-verified outcome/i, "Downloadable fixtures must not auto-verify negative content outcomes.");
assert.match(documentScenario.steps[0].expected, /local parse\/content-rule.*scanner.*authenticity/i, "Local parsing, scanner observations and authenticity must remain distinct.");
assert.match(catalog.REQUIREMENTS.find((item) => item.id === "UAT-REQ-03").exactBaseline, /production pure predicates.*run-owned/i, "Evaluator predicates must be run-owned and non-mutating.");
execFileSync("node", ["scripts/generate-uat-learning-deliverables.mjs"], { cwd: root, stdio: "inherit" });
for (const file of ["deliverables/onboarding-control-tower-learning-guide.html", "deliverables/onboarding-uat-traceability-matrix.csv", "docs/onboarding-product-feature-inventory.json"]) {
  assert.ok(existsSync(resolve(root, file)), `${file} should be generated.`);
}
const html = readFileSync(resolve(root, "deliverables/onboarding-control-tower-learning-guide.html"), "utf8");
const matrix = readFileSync(resolve(root, "deliverables/onboarding-uat-traceability-matrix.csv"), "utf8");
assert.match(html, /Workforce transfers/);
assert.match(html, /Workforce context, frontline release and early tenure/);
assert.match(html, /no executed assertions are claimed by this document/);
assert.match(html, /Historical test records are restricted, read-only and permanently non-operational/);
assert.match(html, /A score or status label never substitutes for authority or safety gates/);
for (const label of ["Offer-Acceptance Package", "Background Checks", "Day-1 Readiness"]) assert.ok(html.includes(label));
assert.doesNotMatch(html, /\b(?:Gateway|Gate) [ABC]\b/);
assert.match(matrix, /"APP-A-22"/);
assert.match(matrix, /"APP-B-12"/);
assert.match(matrix, /"verification"/);
assert.match(matrix, /"independent observation required"/);