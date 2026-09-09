import assert from "node:assert/strict";
import test from "node:test";
import coverage from "../../../../research/intent-agent-coverage.json";
import { intents } from "../data/intents";
import {
  assertRegistryReconciled,
  buildIntentRegistry,
  IntentResolutionError,
  validateCustomRoutingMetadata,
} from "./intent-registry";
import type { CustomIntentRow } from "@workspace/db";

function customRow(overrides: Partial<CustomIntentRow> = {}): CustomIntentRow {
  return {
    id: 1,
    organizationId: "demo",
    key: "client-outcome",
    name: "Client Outcome",
    domain: "hire",
    flowClass: "fc2-policy",
    description: "Client-specific outcome",
    asIsHandlingMin: 10,
    toBeHumanMin: 2,
    baseWeight: 1,
    actGetActions: 1,
    actPutActions: 0,
    systemsTouchedBase: 1,
    tags: '["custom"]',
    source: "client-approved",
    author: "test",
    status: "active",
    registryVersion: "research-v1",
    parentIntentKey: "onboarding-case",
    exactAliases: '["client_alias"]',
    accountableSpecialist: "Onboarding Coordinator",
    riskClass: "medium",
    actionSchema: '{"actions":[]}',
    evidenceContract: '{"required":["actor"]}',
    maturity: "catalogued",
    createdAt: new Date("2026-09-08T00:00:00Z"),
    updatedAt: new Date("2026-09-08T00:00:00Z"),
    ...overrides,
  };
}

test("registry reconciles the approved taxonomy with the cost model", () => {
  assert.doesNotThrow(assertRegistryReconciled);
  const registry = buildIntentRegistry();
  assert.equal(registry.counts.reference, 60);
  assert.equal(registry.counts.reference, intents.length);
  assert.equal(registry.counts.groupingParents, 38);
  assert.equal(registry.counts.candidateGaps, 6);
  assert.deepEqual(registry.counts, {
    reference: coverage.counts.referenceSubIntents,
    activeCustom: 0,
    retiredCustom: 0,
    staleCustom: 0,
    groupingParents: coverage.counts.parentIntents,
    candidateGaps: coverage.counts.candidateGaps,
    routable: 2,
  });
});

test("custom rows from another registry version enter the repair path", () => {
  const registry = buildIntentRegistry([
    customRow({ registryVersion: "legacy-v0", exactAliases: '["legacy_alias"]' }),
  ]);
  assert.equal(registry.counts.activeCustom, 0);
  assert.equal(registry.counts.staleCustom, 1);
  assert.throws(
    () => registry.resolve("legacy_alias"),
    (error) => error instanceof IntentResolutionError && error.code === "REGISTRY_VERSION_MISMATCH",
  );
});

test("custom executable actions require one registered executor owned by the accountable specialist", () => {
  assert.doesNotThrow(() => validateCustomRoutingMetadata({
    accountableSpecialist: "Onboarding Coordinator",
    riskClass: "medium",
    maturity: "simulated",
    exactAliases: ["client_alias"],
    actionSchema: {
      actions: [{
        type: "workflow",
        name: "run-onboarding",
        description: "Run the bounded onboarding workflow.",
        inputSchema: { type: "object" },
        executorKey: "onboarding-case-workflow",
      }],
    },
    evidenceContract: { completionEvidence: "The onboarding case is complete.", required: ["caseId"] },
  }));
  assert.throws(
    () => validateCustomRoutingMetadata({
      accountableSpecialist: "Payroll Operations Specialist",
      riskClass: "medium",
      maturity: "simulated",
      exactAliases: [],
      actionSchema: {
        actions: [{
          type: "workflow",
          name: "run-onboarding",
          description: "Incorrectly assigned executor.",
          inputSchema: { type: "object" },
          executorKey: "onboarding-case-workflow",
        }],
      },
      evidenceContract: { completionEvidence: "The onboarding case is complete.", required: ["caseId"] },
    }),
    /not Payroll Operations Specialist/,
  );
  assert.throws(
    () => validateCustomRoutingMetadata({
      accountableSpecialist: "Onboarding Coordinator",
      riskClass: "medium",
      maturity: "verified",
      exactAliases: [],
      actionSchema: {
        actions: [{
          type: "workflow",
          name: "run-onboarding",
          description: "Overstated workflow maturity.",
          inputSchema: { type: "object" },
          executorKey: "onboarding-case-workflow",
        }],
      },
      evidenceContract: { completionEvidence: "The onboarding case is complete.", required: ["caseId"] },
    }),
    /only proven to simulated maturity/,
  );
});

test("executable routes require completion evidence and fail closed if stored ownership drifts", () => {
  assert.throws(
    () => validateCustomRoutingMetadata({
      accountableSpecialist: "Onboarding Coordinator",
      riskClass: "medium",
      maturity: "simulated",
      exactAliases: [],
      actionSchema: {
        actions: [{
          type: "workflow",
          name: "run-onboarding",
          description: "Run the bounded onboarding workflow.",
          inputSchema: { type: "object" },
          executorKey: "onboarding-case-workflow",
        }],
      },
      evidenceContract: { completionEvidence: " ", required: ["caseId"] },
    }),
    /must explain what proves/,
  );

  const registry = buildIntentRegistry([
    customRow({
      parentIntentKey: "onboarding-case",
      accountableSpecialist: "Payroll Operations Specialist",
      maturity: "simulated",
      actionSchema: JSON.stringify({
        actions: [{
          type: "workflow",
          name: "run-onboarding",
          description: "Stored route with drifted ownership.",
          inputSchema: { type: "object" },
          executorKey: "onboarding-case-workflow",
        }],
      }),
      evidenceContract: JSON.stringify({
        completionEvidence: "The onboarding case is complete.",
        required: ["caseId"],
      }),
    }),
  ]);
  assert.equal(registry.custom[0]?.routable, false);
  assert.throws(
    () => registry.resolve("client-outcome"),
    (error) => error instanceof IntentResolutionError && error.code === "UNSUPPORTED_OUTCOME",
  );
});

test("only exact aliases resolve and every routable action has one executor", () => {
  const registry = buildIntentRegistry();
  const route = registry.resolve("new-hire-setup");
  assert.equal(route.accountableSpecialist, "Onboarding Coordinator");
  assert.equal(route.routable, true);
  assert.ok(route.actionSchema.actions.length > 0);
  for (const action of route.actionSchema.actions) {
    assert.equal(action.executorKey, "onboarding-case-workflow");
    assert.equal(registry.executors.filter((executor) => executor.key === action.executorKey).length, 1);
  }
  assert.throws(
    () => registry.resolve("harassment_report"),
    (error) => error instanceof IntentResolutionError && error.code === "UNSUPPORTED_OUTCOME",
  );
});

test("unknown, unsupported, retired, and wrong-version outcomes fail explicitly", () => {
  const registry = buildIntentRegistry([customRow({ status: "retired" })]);
  const cases = [
    ["does-not-exist", undefined, "UNKNOWN_OUTCOME"],
    ["payslip-copy", undefined, "UNSUPPORTED_OUTCOME"],
    ["client_alias", undefined, "RETIRED_OUTCOME"],
    ["new-hire-setup", "old-version", "REGISTRY_VERSION_MISMATCH"],
  ] as const;
  for (const [key, version, code] of cases) {
    assert.throws(
      () => registry.resolve(key, version),
      (error) => error instanceof IntentResolutionError
        && error.code === code
        && error.repair.required,
    );
  }
});

test("custom lifecycle classes remain separately counted", () => {
  const registry = buildIntentRegistry([
    customRow(),
    customRow({ id: 2, key: "retired-outcome", exactAliases: "[]", status: "retired" }),
  ]);
  assert.equal(registry.counts.reference, 60);
  assert.equal(registry.counts.activeCustom, 1);
  assert.equal(registry.counts.retiredCustom, 1);
  assert.equal(registry.counts.groupingParents, 38);
  assert.equal(registry.counts.candidateGaps, 6);
});