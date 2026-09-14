#!/usr/bin/env node
/**
 * Builds portable reviewer artifacts from the canonical server catalog.
 * Usage: node scripts/generate-uat-learning-deliverables.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, ".cache", "uat-learning-catalog.bundle.mjs");
mkdirSync(resolve(root, ".cache"), { recursive: true });
rmSync(out, { force: true });
execFileSync(
  resolve(root, "artifacts/api-server/node_modules/.bin/esbuild"),
  ["artifacts/api-server/src/lib/onboarding/uat-learning-catalog.ts", "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${out}`],
  { cwd: root, stdio: "inherit" },
);
const catalog = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
const { PRODUCT_FEATURES, REQUIREMENTS, GUIDE_SECTIONS, UAT_SCENARIOS, FEATURE_COVERAGE, REQUIREMENT_COVERAGE, UAT_LEARNING_CATALOG_VERSION, UAT_LEARNING_BASELINE, inventoryConsistencyIssues } = catalog;
const issues = inventoryConsistencyIssues();
if (issues.length) throw new Error(`Catalog consistency failed:\n${issues.join("\n")}`);

const csv = (cells) => cells.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",");
const matrixHeader = ["requirement_id", "title", "source_refs", "exact_baseline", "actor", "case_variants", "implementation_availability", "reference_coverage", "scenario_ids", "test_mode", "expected_evidence", "execution_assertion_status", "latest_result", "gap_owner", "gap_reason"];
const matrix = [
  csv(matrixHeader),
  ...REQUIREMENTS.map((item) => csv([item.id, item.title, item.sourceRefs.join(" | "), item.exactBaseline, item.actor, item.variants.join(" | "), item.availability, "mapped", item.scenarioIds.join(" | "), item.testMode, item.expectedEvidence, "not-executed", item.latestResult, item.gapOwner, item.gapReason])),
].join("\n") + "\n";

const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
const scenarioRows = UAT_SCENARIOS.map((item) => `
  <article class="scenario">
    <h3>${escapeHtml(item.id)} — ${escapeHtml(item.title)}</h3>
    <p><strong>Family:</strong> ${escapeHtml(item.family)} · <strong>Mode:</strong> ${escapeHtml(item.mode)} · <strong>Availability:</strong> ${escapeHtml(item.status)}</p>
    <p>${escapeHtml(item.description)}</p>
    <p class="notice"><strong>Execution boundary:</strong> ${escapeHtml(item.prerequisites?.[0] ?? "Record the applicable boundary before execution.")}</p>
    ${item.blocker ? `<p class="blocked"><strong>Verification gap:</strong> ${escapeHtml(item.blocker)}</p>` : ""}
    <p><strong>Roles:</strong> ${escapeHtml(item.roles.join(" · "))}</p>
    <ol>${item.steps.map((step) => `<li><strong>${escapeHtml(step.actor)}:</strong> ${escapeHtml(step.action)}<br><em>Expected:</em> ${escapeHtml(step.expected)}<br><em>Evidence:</em> ${escapeHtml(step.evidence)}<br><em>Wait:</em> ${escapeHtml(step.wait)}${step.negativePath ? `<br><em>Negative path:</em> ${escapeHtml(step.negativePath)}` : ""}</li>`).join("")}</ol>
  </article>`).join("\n");
const guideRows = GUIDE_SECTIONS.map((section) => `
  <section>
    <h2 id="${escapeHtml(section.id)}">${escapeHtml(section.title)}</h2>
    <p class="meta"><strong>Roles:</strong> ${escapeHtml(section.roles.join(" · "))} · <strong>Entry:</strong> ${escapeHtml(section.entryPoints.join(" · "))}</p>
    <p>${escapeHtml(section.summary)}</p>
    <h3>How to use this area</h3>${list(section.instructions)}
    <h3>Evidence to retain</h3>${list(section.evidence)}
    <h3>Exceptions and boundaries</h3>${list(section.exceptions)}
    <p class="links">Features: ${escapeHtml(section.featureIds.join(", "))} · Scenarios: ${escapeHtml(section.scenarioIds.join(", "))}</p>
  </section>`).join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Onboarding Control Tower — Product Learning Guide</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#172033;margin:0;background:#f6f8fc}main{max-width:1050px;margin:auto;padding:32px;background:white}h1{color:#273b9d}h2{margin-top:36px;padding-top:12px;border-top:1px solid #dce1ed}h3{margin-bottom:4px}.notice,.blocked{padding:12px;border-radius:6px;background:#fff7df;border:1px solid #e4b650}.meta,.links{font-size:.9rem;color:#4c5b74}.scenario{border:1px solid #dce1ed;padding:18px;margin:16px 0;border-radius:8px;break-inside:avoid}li{margin:6px 0}table{border-collapse:collapse;width:100%;font-size:.83rem}th,td{border:1px solid #dce1ed;padding:7px;text-align:left;vertical-align:top}th{background:#edf1ff}@media print{body{background:white}main{padding:0}.scenario{break-inside:avoid}}
</style></head><body><main>
<h1>Onboarding Control Tower — Product Learning Guide</h1>
<p><strong>Catalog version:</strong> ${escapeHtml(UAT_LEARNING_CATALOG_VERSION)}<br><strong>Baseline:</strong> ${escapeHtml(UAT_LEARNING_BASELINE)}</p>
<p class="notice"><strong>Evidence boundary:</strong> This guide describes product operation and test evidence. Reference coverage is a catalog mapping, not an executed assertion or proof that a test passed. Simulated evidence does not certify a vendor, scanner, source authenticity, specialist decision, or live readiness. The BRD remains Draft for Review with conflicting version labels.</p>
<h2>Product-operation and UAT boundary</h2><p>Product-guide instructions describe authorized real operation; they do not make generic Case, Batch, Transfer, configuration, or provider actions isolated UAT flows. For a simulated scenario, start in Test Center and use only its run-owned linked case, candidate portal, or evaluator. The evaluator may use actual production pure predicates only on run-owned fixture/snapshot state. It must not mutate real-case readiness, dispatch providers, or change global time, credentials, leases, or real deadlines. If a real workflow, specialist role, approval, or provider is required, record <strong>Manual</strong> or <strong>Blocked</strong>.</p>
<h2>Coverage statement</h2><p><strong>Reference coverage:</strong> product features ${FEATURE_COVERAGE.referenceMapped}/${FEATURE_COVERAGE.denominator} mapped; ${FEATURE_COVERAGE.withGuide} linked to a guide and ${FEATURE_COVERAGE.withScenario} linked to scenarios. BRD/cross-cutting requirements ${REQUIREMENT_COVERAGE.referenceMapped}/${REQUIREMENT_COVERAGE.denominator} mapped to a test route. <strong>Executed assertions recorded by this static catalog:</strong> features ${FEATURE_COVERAGE.executedAssertions}; requirements ${REQUIREMENT_COVERAGE.executedAssertions}. Execution results belong in a Test Center run/evidence record, not this export. Unavailable or policy-dependent requirements: ${REQUIREMENT_COVERAGE.unavailableOrPolicyDependent}; provider-sandbox routes: ${REQUIREMENT_COVERAGE.providerSandboxBlocked}.</p>
${guideRows}
<h2>Scenario instructions</h2>${scenarioRows}
<h2>Feature inventory</h2><table><thead><tr><th>ID</th><th>Feature</th><th>Entry point</th><th>Guide</th><th>Reference coverage</th><th>Executed assertion</th><th>Verification</th></tr></thead><tbody>
${PRODUCT_FEATURES.map((feature) => `<tr><td>${escapeHtml(feature.id)}</td><td>${escapeHtml(feature.name)}</td><td>${escapeHtml(feature.entryPoints.join(" · "))}</td><td>${escapeHtml(feature.guideTopic)}</td><td>${escapeHtml(feature.referenceCoverage)}: ${escapeHtml(feature.scenarioIds.join(", "))}</td><td>${escapeHtml(feature.executionAssertion)}</td><td>${escapeHtml(feature.verification)}<br>${escapeHtml(feature.availabilityNote)}</td></tr>`).join("\n")}
</tbody></table>
<h2>Requirement-to-test traceability</h2><p>Use the accompanying CSV for sortable review. Its <em>reference_coverage</em> field is a route mapping; <em>execution_assertion_status</em> is intentionally <em>not-executed</em>. Latest result is intentionally <em>Not run</em>, <em>Blocked</em> or <em>Manual</em> until independently observed; this export makes no overall verification claim.</p>
<table><thead><tr><th>ID</th><th>Baseline/source</th><th>Scenarios</th><th>Mode</th><th>Availability / gap</th></tr></thead><tbody>
${REQUIREMENTS.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.exactBaseline)}<br><small>${escapeHtml(item.sourceRefs.join(" · "))}</small></td><td>${escapeHtml(item.scenarioIds.join(", "))}</td><td>${escapeHtml(item.testMode)}</td><td>${escapeHtml(item.availability)}<br>${escapeHtml(item.gapReason ?? "Observation required.")}</td></tr>`).join("\n")}
</tbody></table>
</main></body></html>`;

const inventory = {
  catalogVersion: UAT_LEARNING_CATALOG_VERSION,
  baseline: UAT_LEARNING_BASELINE,
  generatedBy: "scripts/generate-uat-learning-deliverables.mjs",
  coverageRule: "Reference coverage is a scenario mapping, not an executed assertion, passing result, or live/provider approval.",
  executionAssertionStatus: "not-executed: execution evidence belongs in a Test Center run, not this static inventory.",
  denominators: { featureCoverage: FEATURE_COVERAGE, requirementCoverage: REQUIREMENT_COVERAGE },
  features: PRODUCT_FEATURES,
  guideSections: GUIDE_SECTIONS.map(({ id, title, featureIds, scenarioIds }) => ({ id, title, featureIds, scenarioIds })),
};
mkdirSync(resolve(root, "deliverables"), { recursive: true });
writeFileSync(resolve(root, "docs/onboarding-product-feature-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(resolve(root, "docs/onboarding-uat-traceability-matrix.csv"), matrix);
writeFileSync(resolve(root, "deliverables/onboarding-uat-traceability-matrix.csv"), matrix);
writeFileSync(resolve(root, "deliverables/onboarding-control-tower-learning-guide.html"), html);
console.log(`Generated ${PRODUCT_FEATURES.length} features, ${REQUIREMENTS.length} requirements, ${UAT_SCENARIOS.length} scenarios and ${GUIDE_SECTIONS.length} guide sections.`);