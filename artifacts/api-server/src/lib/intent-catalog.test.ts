import test from "node:test";
import assert from "node:assert/strict";
import type { CustomIntentRow } from "@workspace/db";
import master from "../../../../research/hro-master-intent-taxonomy.json";
import { buildIntentCatalog, catalogDefinition, validateCatalogIntegrity } from "./intent-catalog";
import { buildIntentRegistry } from "./intent-registry";
import { intents } from "../data/intents";
import { HRO_BATCH_TEMPLATES } from "./onboarding/hro-batch-templates";
import { CURATED_OFFLINE_EXAMPLES } from "./onboarding/offline-example-extension";
import { SCENARIOS } from "./onboarding/scenarios";

function custom(organizationId: string, id: number): CustomIntentRow {
  return { organizationId, id, key: "same-slug", name: `Private ${organizationId}`, domain: "pay", flowClass: "fc1-deterministic",
    description: "Tenant completion", asIsHandlingMin: 10, toBeHumanMin: 2, baseWeight: 1, actGetActions: 1, actPutActions: 0,
    systemsTouchedBase: 1, tags: "[]", source: "Tenant review", author: "Do not expose author", status: "active",
    registryVersion: "retained-version", parentIntentKey: null, exactAliases: "[]", accountableSpecialist: "Not authority",
    riskClass: "low", actionSchema: '{"actions":[]}', evidenceContract: '{"completionEvidence":"Dated tenant record","required":["recordedAt"]}',
    maturity: "verified", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") };
}

test("separate counts reconcile every master, registry, family and curated variation", () => {
  const catalog = buildIntentCatalog();
  assert.deepEqual([catalog.counts.journeys, catalog.counts.services, catalog.counts.masterAtomicOutcomes, catalog.counts.canonicalAtomicDefinitions, catalog.counts.compositeDefinitions, catalog.counts.sampleVariations, catalog.counts.registryEntries],
    [17, 88, 320, 319, 1, 136, 60]);
  assert.equal(catalog.counts.customDefinitions, 0);
  for (const row of [...master.subIntents, ...master.compositeRoutes]) {
    assert.equal(catalog.mappings.filter(item => item.source === "master" && item.sourceKey === row.key).length, 1);
  }
  for (const row of intents) assert.equal(catalog.mappings.filter(item => item.source === "registry" && item.sourceKey === row.key).length, 1);
  for (const row of HRO_BATCH_TEMPLATES) assert.ok(catalog.mappings.some(item => item.source === "case-family" && item.sourceKey === row.id && item.sourceVersion.endsWith(String(row.version))));
  for (const row of CURATED_OFFLINE_EXAMPLES) {
    assert.ok(catalog.mappings.some(item => item.source === "sample" && item.sourceKey === row.key));
    assert.ok(!JSON.stringify(catalog).includes(row.values.workerEmail));
  }
  for (const row of SCENARIOS) assert.ok(catalog.mappings.some(item => item.source === "sample" && item.sourceKey === `retained:${row.key}`));
  assert.equal(catalog.counts.proposedGaps, catalog.gaps.length);
  assert.ok(catalog.gaps.some(item => item.key === "case-family:employee-changes-role"));
});

test("reusable definitions preserve browsing metadata and multiple callers without parent ownership", () => {
  const catalog = buildIntentCatalog();
  const learning = catalogDefinition(catalog, "assign-learning")!;
  assert.deepEqual(new Set(learning.journeyKeys), new Set(["onboarding", "learning-career"]));
  assert.equal(catalogDefinition(catalog, "assign-mandatory-learning"), undefined);
  assert.equal(catalog.mappings.find(item => item.sourceKey === "assign-mandatory-learning")?.definitionKeys[0], learning.key);
  const access = catalogDefinition(catalog, "provision-role-access")!;
  assert.equal(access.name, "Grant IT application access");
  assert.ok(access.initiation.standalone && access.initiation.composed && access.initiation.human && access.initiation.ai);
  assert.equal(access.initiation.reviewStatus, "proposed");
  assert.deepEqual(catalog.compositions.filter(edge => edge.calleeKey === access.key).map(edge => edge.callerKey), ["new-hire-setup", "domestic-transfer"]);
  assert.ok(catalog.compositions.every(edge => edge.reviewStatus === "proposed" && edge.inputMappings.length));
  assert.ok(catalog.compositions.some(edge => edge.completionDependency === "independent"));
  assert.equal("parentIntentKey" in access, false);
});

test("current evidence never inherits legacy research or tenant declared maturity", () => {
  const catalog = buildIntentCatalog([custom("one", 1)], "one");
  assert.ok(catalog.definitions.every(row => ["catalogued", "illustrative"].includes(row.coverage)));
  assert.equal(catalogDefinition(catalog, "custom:1")?.coverage, "catalogued");
  assert.ok(catalogDefinition(catalog, "background-check-chase")?.coverageEvidence.some(item => item.includes("Legacy")));
  assert.equal(catalog.instanceContract.implemented, false);
  assert.deepEqual([catalog.instanceContract.maximumDepth, catalog.instanceContract.maximumChildren, catalog.instanceContract.maximumTreeSize], [8, 50, 500]);
});

test("tenant scope is required and double-filtered; custom versions are stable and reflect edits", () => {
  const one = custom("one", 1), two = custom("two", 2);
  assert.throws(() => buildIntentCatalog([one]), /tenant scope/);
  const catalog = buildIntentCatalog([one, two], "one");
  assert.equal(catalog.counts.customDefinitions, 1);
  assert.equal(catalogDefinition(catalog, "custom:2"), undefined);
  assert.ok(!JSON.stringify(catalog).includes("Private two"));
  assert.ok(!JSON.stringify(catalog).includes(one.author));
  assert.equal(catalogDefinition(catalog, "custom:1")?.version, catalogDefinition(buildIntentCatalog([one], "one"), "custom:1")?.version);
  assert.notEqual(catalogDefinition(catalog, "custom:1")?.version, catalogDefinition(buildIntentCatalog([{ ...one, description: "Revised" }], "one"), "custom:1")?.version);
  assert.equal(catalogDefinition(buildIntentCatalog([{ ...one, status: "retired" }], "one"), "custom:1")?.status, "retired");
});

test("invalid hierarchy, orphan targets, duplicate identities, count drift and cycles fail explicitly", () => {
  const catalog = buildIntentCatalog();
  const duplicate = structuredClone(catalog); duplicate.definitions.push(duplicate.definitions[0]!);
  assert.throws(() => validateCatalogIntegrity(duplicate), /Duplicate catalog/);
  const orphan = structuredClone(catalog); orphan.mappings[0]!.definitionKeys = ["unknown"];
  assert.throws(() => validateCatalogIntegrity(orphan), /mapping target/);
  const hierarchy = structuredClone(catalog); hierarchy.services[0]!.journeyKey = "unknown";
  assert.throws(() => validateCatalogIntegrity(hierarchy), /Orphan service/);
  const counts = structuredClone(catalog); counts.counts.registryEntries++;
  assert.throws(() => validateCatalogIntegrity(counts), /counts mismatch/);
  const cycle = structuredClone(catalog);
  cycle.compositions.push({ ...cycle.compositions[0]!, key: "cycle", callerKey: "provision-role-access", calleeKey: "new-hire-setup" });
  assert.throws(() => validateCatalogIntegrity(cycle), /cycle/);
});

test("catalog and export assembly are deterministic, unknowns never route, commercial baseline unchanged", () => {
  const before = JSON.stringify(intents), registryBefore = buildIntentRegistry();
  const catalog = buildIntentCatalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), buildIntentCatalog());
  assert.equal(catalogDefinition(catalog, "unknown-outcome"), undefined);
  assert.equal(catalogDefinition(catalog, "standalone-access-request"), undefined); // no implicit alias execution
  assert.equal(JSON.stringify(intents), before);
  assert.deepEqual(buildIntentRegistry().reference, registryBefore.reference);
  assert.equal(intents.length, 60);
  assert.ok(!("instances" in catalog) && !("executors" in catalog));
});
