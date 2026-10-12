#!/usr/bin/env node
/** Distributed documents use the same current-operation catalog as the API. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, "..");
const bundle = resolve(root, ".cache/product-learning-catalog.mjs");
mkdirSync(resolve(root, ".cache"), { recursive: true });
execFileSync(resolve(root, "artifacts/api-server/node_modules/.bin/esbuild"), [
  "artifacts/api-server/src/lib/onboarding/product-learning-catalog.ts", "--bundle",
  "--platform=node", "--format=esm", "--target=node20", `--outfile=${bundle}`,
], { cwd: root, stdio: "inherit" });
const catalog = await import(pathToFileURL(bundle).href);
const { PRODUCT_FEATURES, REQUIREMENTS, GUIDE_SECTIONS, FEATURE_COVERAGE, REQUIREMENT_COVERAGE,
  UAT_LEARNING_CATALOG_VERSION, UAT_LEARNING_BASELINE } = catalog;
const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const list = items => `<ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
const boundary = "Historical test records are restricted, read-only and permanently non-operational. They cannot dispatch, gain authority, satisfy readiness gates or enter real outcome metrics. Static mappings are not executed assertions, source authentication, vendor certification or evidence of live readiness.";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Tower — Operation and Evidence Guide</title><style>body{font:16px/1.6 system-ui;color:#172033;margin:0;background:#f6f8fc}main{max-width:1050px;margin:auto;padding:24px;background:white}h1,h2{color:#273b9d}section{border-top:1px solid #ddd;margin-top:24px;padding-top:16px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:8px;text-align:left;overflow-wrap:anywhere}.notice{background:#fff7df;padding:16px}@media(max-width:600px){main{padding:16px}table{display:block;overflow-x:auto}}</style></head><body><main>
<h1>Control Tower — Operation and Evidence Guide</h1><p>Catalog: ${esc(UAT_LEARNING_CATALOG_VERSION)} · Source baseline: ${esc(UAT_LEARNING_BASELINE)}</p><p class="notice">${esc(boundary)}</p>
${GUIDE_SECTIONS.map(g => `<section><h2>${esc(g.title)}</h2><p>${esc(g.summary)}</p><p>Authorized area: ${esc(g.entryPoints.join(" · "))}</p><h3>Instructions</h3>${list(g.instructions)}<h3>Evidence requirements</h3>${list(g.evidence)}<h3>Limits and exceptions</h3>${list(g.exceptions)}</section>`).join("")}
<section><h2>Current feature inventory</h2><p>${PRODUCT_FEATURES.length} features mapped; no executed assertions are claimed by this document.</p>
<table><tr><th>Feature</th><th>Authorized area</th><th>Evidence boundary</th></tr>${PRODUCT_FEATURES.map(f => `<tr><td>${esc(f.id)} — ${esc(f.name)}</td><td>${esc(f.entryPoints.join(" · "))}</td><td>${esc(f.availabilityNote)}</td></tr>`).join("")}</table></section>
<section><h2>Source requirements and limitations</h2><p>Historical baseline quotations are retained as source evidence, not current feature or execution claims.</p>
<table><tr><th>Requirement</th><th>Source baseline</th><th>Availability and evidence</th></tr>${REQUIREMENTS.map(r => `<tr><td>${esc(r.id)} — ${esc(r.title)}</td><td>${esc(r.exactBaseline)}<br>${esc(r.sourceRefs.join(" · "))}</td><td>${esc(r.availability)}<br>${esc(r.expectedEvidence)}<br>${esc(r.gapReason)}</td></tr>`).join("")}</table></section></main></body></html>`;
const inventory = {
  catalogVersion: UAT_LEARNING_CATALOG_VERSION, baseline: UAT_LEARNING_BASELINE,
  generatedBy: "scripts/generate-uat-learning-deliverables.mjs",
  coverageRule: boundary, executionAssertionStatus: "not-executed",
  denominators: { featureCoverage: FEATURE_COVERAGE, requirementCoverage: REQUIREMENT_COVERAGE },
  features: PRODUCT_FEATURES, guideSections: GUIDE_SECTIONS,
};
const csv = cells => cells.map(c => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",");
const matrix = [
  csv(["requirement_id", "title", "source_refs", "exact_baseline", "actor", "availability", "expected_evidence", "verification", "gap_owner", "limitation"]),
  ...REQUIREMENTS.map(r => csv([r.id, r.title, r.sourceRefs.join(" | "), r.exactBaseline, r.actor, r.availability, r.expectedEvidence, "independent observation required", r.gapOwner, r.gapReason])),
].join("\n") + "\n";
mkdirSync(resolve(root, "deliverables"), { recursive: true });
writeFileSync(resolve(root, "docs/onboarding-product-feature-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
for (const folder of ["docs", "deliverables"]) writeFileSync(resolve(root, folder, "onboarding-uat-traceability-matrix.csv"), matrix);
for (const name of ["onboarding-control-tower-learning-guide.html", "onboarding-learning-uat-verification.html"]) writeFileSync(resolve(root, "deliverables", name), html);
writeFileSync(resolve(root, "docs/hro-onboarding-tester-guide.md"), [
  "# Authorized operation and evidence review", "", boundary, "",
  ...GUIDE_SECTIONS.flatMap(g => [`## ${g.title}`, g.summary, "", ...g.instructions.map(i => `- ${i}`), "", "Evidence:", ...g.evidence.map(i => `- ${i}`), "", "Limits:", ...g.exceptions.map(i => `- ${i}`), ""]),
].join("\n"));
execFileSync("python", ["scripts/export-learning-guide-word.py"], { cwd: root, stdio: "inherit" });
execFileSync("python", ["scripts/export-learning-guide-word.py", "deliverables/onboarding-learning-uat-verification.html", "deliverables/hro-onboarding-tester-guide.docx"], { cwd: root, stdio: "inherit" });
rmSync(bundle);
console.log(`Generated ${PRODUCT_FEATURES.length} current features, ${REQUIREMENTS.length} source requirements and ${GUIDE_SECTIONS.length} operational guide sections.`);
