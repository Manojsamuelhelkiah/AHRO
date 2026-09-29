import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isExplicitSyntheticDemoCase,
  isVerifiedHybridDemoControllerCase,
} from "./demo-admin-access";
import {
  SYNTHETIC_OFFLINE_MARKER,
} from "./synthetic-offline";

test("synthetic Demo read access requires server-owned provenance as well as the offline marker", () => {
  assert.equal(isExplicitSyntheticDemoCase({
    notes: SYNTHETIC_OFFLINE_MARKER,
    scenarioKey: "demo-case",
    syntheticProvenance: "onboarding-demo-fictional",
  }), true);
  assert.equal(isExplicitSyntheticDemoCase({
    notes: null,
    scenarioKey: "ordinary-case",
    syntheticProvenance: null,
  }), false);

  const clientBatchLikeCase = {
    notes: SYNTHETIC_OFFLINE_MARKER,
    scenarioKey: "ordinary-batch-case",
    syntheticProvenance: null,
    workforceContext: { hiringMode: "batch" },
  };
  assert.equal(
    isExplicitSyntheticDemoCase(clientBatchLikeCase),
    false,
    "a batch-like case cannot acquire synthetic status by copying client-visible marker text",
  );

  assert.equal(isExplicitSyntheticDemoCase({
    notes: `${SYNTHETIC_OFFLINE_MARKER}\nUAT fixture`,
    scenarioKey: "UAT-CLIENT-02",
    syntheticProvenance: "onboarding-demo-fictional",
  }), false);
});

test("volunteer-backed hybrid access remains a separate verified Demo Controller path", () => {
  assert.equal(isVerifiedHybridDemoControllerCase({
    notes: "[demo-controller-run:run-1]",
    scenarioKey: "demo-controller",
    candidateEmailAuthorizedAt: new Date(),
    candidateEmailAuthorizedBy: "demo-controller",
  }), true);
  assert.equal(isVerifiedHybridDemoControllerCase({
    notes: `${SYNTHETIC_OFFLINE_MARKER}\n[demo-controller-run:forged]`,
    scenarioKey: "ordinary-case",
    candidateEmailAuthorizedAt: null,
    candidateEmailAuthorizedBy: null,
  }), false);
  assert.equal(isVerifiedHybridDemoControllerCase({
    notes: "[demo-controller-run:run-1]",
    scenarioKey: "UAT-CLIENT-02",
    candidateEmailAuthorizedAt: new Date(),
    candidateEmailAuthorizedBy: "demo-controller",
  }), false);
});