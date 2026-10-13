import assert from "node:assert/strict";
import { test } from "node:test";
import type { onbCases } from "@workspace/db/schema";
import { originalIntentLabel, resolveOriginalIntent, onboardingOriginalIntent, templateOriginalIntent } from "./original-intent";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { findHroTemplate, hroRequestForRow } from "./hro-batch-templates";

type Row = typeof onbCases.$inferSelect;
const unknown = {
  organizationId: "tenant", scenarioKey: null, syntheticProvenance: null,
  workerName: "Worker", workerEmail: "worker@example.com", workerPhone: null,
  candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null, notes: null,
  processPolicySnapshot: {}, originalIntent: null, operationalActivation: null,
} as Row;

test("workflow state, access workstreams, titles and fallback hire type never establish origin", () => {
  for (const hireType of ["external-fte", "service-request", "internal-transfer"]) {
    assert.equal(originalIntentLabel({ ...unknown, hireType, planSummary: "Application jurisdiction inquiry",
      lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval",
      workstreams: [{ key: "access", label: "Application access", status: "blocked" }] } as Row, true), "Not recorded");
  }
});

test("recorded onboarding and standalone requests stay distinct through title and state changes", () => {
  const onboarding = { ...unknown, originalIntent: onboardingOriginalIntent("direct-onboarding-intake") };
  const access = { ...unknown, originalIntent: templateOriginalIntent("it-access-request") };
  for (const orchestrationStatus of ["idle", "running", "waiting-approval", "done"]) {
    assert.equal(originalIntentLabel({ ...onboarding, orchestrationStatus, processPolicySnapshot: {
      batchIntake: hroRequestForRow(findHroTemplate("it-access-request")!, { request_id: "later-access" }),
    } }, true), "Onboarding");
    assert.equal(originalIntentLabel({ ...access, orchestrationStatus }, true), "Application access request");
  }
});

test("verified curated jurisdiction example resolves from definition, not database number or title", () => {
  const example = CURATED_OFFLINE_EXAMPLES.find(item => item.title === "Application jurisdiction inquiry")!;
  for (const id of [42, 900123]) {
    const row = { ...unknown, ...example.values, organizationId: "demo", id, originalIntent: null } as Row;
    assert.equal(originalIntentLabel(row, true), "Application access request");
    assert.equal(originalIntentLabel({ ...row, workerName: "Other worker", processPolicySnapshot: {} }, true), "Not recorded");
  }
});

test("legacy batch origins require valid recorded intake, never submitted request titles", () => {
  const request = hroRequestForRow(findHroTemplate("it-access-request")!, { request_id: "original", request_summary: "Private narrative" });
  const row = { ...unknown, processPolicySnapshot: { batchIntake: { ...request, requestType: "Private scenario title" } } };
  assert.equal(resolveOriginalIntent(row)?.label, "Application access request");
  assert.equal(originalIntentLabel({ ...row, processPolicySnapshot: { batchIntake: {
    ...request, fingerprint: "tampered",
  } } }, true), "Not recorded");
});

test("restricted projection contains neither intent nor source narratives", () => {
  const row = { ...unknown, originalIntent: templateOriginalIntent("it-access-request"),
    processPolicySnapshot: { requester: "private", justification: "private" } };
  assert.equal(originalIntentLabel(row, false), null);
  assert.equal(originalIntentLabel(row, true), "Application access request");
});

test("operational current request never overwrites original fictional provenance", () => {
  const example = CURATED_OFFLINE_EXAMPLES.find(item => item.title === "Application jurisdiction inquiry")!;
  const originalIntent = resolveOriginalIntent({ ...unknown, ...example.values, organizationId: "demo", originalIntent: null } as Row);
  const activated = { ...unknown, originalIntent, operationalActivation: { generation: "new" },
    processPolicySnapshot: { batchIntake: hroRequestForRow(findHroTemplate("onboarding-external-fte")!, { request_id: "current" }) } } as unknown as Row;
  assert.equal(originalIntentLabel(activated, true), "Application access request");
  assert.equal(originalIntentLabel({ ...activated, originalIntent: null }, true), "Not recorded");
});
