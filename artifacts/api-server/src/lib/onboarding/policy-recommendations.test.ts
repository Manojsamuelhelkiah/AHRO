import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeCohortLearning, parseLearningPolicy } from "./policy-recommendations";

const asOf = new Date("2025-04-01T00:00:00.000Z");
const policy = {
  timing: { anchor: "joining-date", offsetDays: -3 },
  sequence: ["safety", "role induction"],
  channel: "manager-led",
  ownership: "learning-operations",
};
const profiles = [{ profileId: "site", version: 2, name: "Site onboarding", criteria: { workEnvironment: "site" }, priority: 20, enabled: true }];
const c = (id: number, scenarioKey: string | null = null) => ({
  id, createdAt: new Date(`2025-03-${String(id + 10).padStart(2, "0")}T00:00:00.000Z`), scenarioKey,
  lifecycleStage: "complete", gateCApprovalStatus: "approved", checklistProfileId: "site", checklistProfileVersion: 2, checklistProfileName: "Site onboarding",
  processPolicySnapshot: { processPolicy: { learning: policy } },
});
const event = (id: number) => ({
  caseId: id, agent: "day1-readiness-gate", engine: "human", title: "Gate C Day-1 readiness confirmed by HR",
  detail: "HR recorded final readiness.", createdAt: new Date(`2025-03-${String(id + 12).padStart(2, "0")}T00:00:00.000Z`),
});

describe("cohort learning recommendations", () => {
  test("excludes demo evidence and exposes dated evidence with uncertainty", () => {
    const result = analyzeCohortLearning({
      cases: [c(1), c(2), c(3), c(4), c(5), c(6, "demo")],
      events: [event(1), event(2), event(3), event(4), event(5), event(6)],
      profiles, asOf, windowDays: 90,
    });
    assert.equal(result.recommendations.length, 1);
    const evidence = result.recommendations[0].evidenceSnapshot;
    assert.equal(evidence.sample.verifiedOutcomes, 5);
    assert.equal(evidence.sample.excludedDemoOrSimulation, 1);
    assert.equal(evidence.outcome.observedOutcomeDates.length, 5);
    assert.match(evidence.uncertainty, /not establish/);
  });

  test("reports denominators for the proposed cohort, never tenant-wide totals", () => {
    const remote = { ...profiles[0], profileId: "remote", name: "Remote onboarding", criteria: { workEnvironment: "remote" } };
    const remoteCase = (id: number, complete: boolean) => ({
      ...c(id),
      lifecycleStage: complete ? "complete" : "preboarding",
      checklistProfileId: "remote",
      checklistProfileName: "Remote onboarding",
    });
    const result = analyzeCohortLearning({
      cases: [
        c(1), c(2), c(3), c(4), c(5), c(6, "demo"),
        remoteCase(7, true), remoteCase(8, false), remoteCase(9, false),
      ],
      events: [event(1), event(2), event(3), event(4), event(5), event(6), event(7), event(8), event(9)],
      profiles: [...profiles, remote], asOf, windowDays: 90,
    });
    assert.equal(result.recommendations.length, 1);
    assert.deepEqual(result.recommendations[0].evidenceSnapshot.sample, {
      candidateCases: 6,
      verifiedOutcomes: 5,
      excludedDemoOrSimulation: 1,
      missingOutcomeEvidence: 0,
    });
  });

  test("fails transparently closed for sparse or incomplete policies", () => {
    const result = analyzeCohortLearning({
      cases: [c(1), c(2), c(3), c(4)],
      events: [event(1), event(2), event(3), event(4)],
      profiles, asOf, windowDays: 90,
    });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.fallback?.status, "insufficient-evidence");
    assert.equal(parseLearningPolicy({ channel: "email" }), null);
    assert.equal(parseLearningPolicy({
      timing: { anchor: "offer-acceptance", offsetDays: 0 },
      channel: "portal", ownership: "L&D", sequence: ["Induction"],
    }), null);
    assert.equal(parseLearningPolicy({
      timing: { anchor: "joining-date", offsetDays: 0 },
      channel: "portal", ownership: "L&D", sequence: ["Induction"],
    }), null);
  });

  test("shows wider same-tenant compatible evidence without publishing sparse exact cohorts", () => {
    const historic = (id: number, scenarioKey: string | null = null) => ({
      ...c(id, scenarioKey),
      checklistProfileVersion: 1,
    });
    const incompatiblePolicy = {
      ...policy,
      timing: { anchor: "joining-date" as const, offsetDays: -2 },
    };
    const result = analyzeCohortLearning({
      cases: [
        c(1), c(2), c(3), c(4), c(5), // Current v2: four outcomes, one missing.
        historic(6, "demo"), historic(7), historic(8), historic(9),
        { ...historic(10), processPolicySnapshot: { processPolicy: { learning: incompatiblePolicy } } },
      ],
      events: [
        event(1), event(2), event(3), event(4), event(6), event(7), event(9),
        {
          caseId: 9, agent: "day1-readiness-gate", engine: "human",
          title: "Gate C approval invalidated by changed live readiness evidence",
          detail: "A required document changed after confirmation.",
          createdAt: new Date("2025-03-30T00:00:00.000Z"),
        },
        event(10),
      ],
      profiles, asOf, windowDays: 90,
    });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.fallback?.status, "insufficient-evidence");
    const broader = result.fallback?.broaderEvidence[0];
    assert.equal(broader?.status, "descriptive-only");
    assert.equal(broader?.notEligibleForPublication, true);
    assert.deepEqual(broader?.sample, {
      candidateCases: 9,
      verifiedOutcomes: 5,
      excludedDemoOrSimulation: 1,
      missingOutcomeEvidence: 3,
    });
    assert.deepEqual(broader?.outcome.caseReferences, [1, 2, 3, 4, 7]);
    assert.match(broader?.compatibilityDefinition ?? "", /same canonical profile ID/i);
    assert.match(broader?.uncertainty ?? "", /cannot be published or adopted/i);
  });

  test("retains only typed runtime policies that compile to workforce tasks", () => {
    const parsed = parseLearningPolicy({
      schemaVersion: "workforce-step-runtime/v1",
      timing: { anchor: "joining-date", offsetDays: -1 },
      channel: "manager-led",
      ownership: "L&D",
      steps: [{ id: "safety", label: "Safety induction", evidenceRequired: true }],
    });
    assert.deepEqual(parsed?.steps, [{ id: "safety", label: "Safety induction", evidenceRequired: true }]);
  });

  test("never accepts even human-recorded outcomes from a demo-only analysis", () => {
    const result = analyzeCohortLearning({
      cases: [c(1), c(2), c(3), c(4), c(5)],
      events: [event(1), event(2), event(3), event(4), event(5)],
      profiles, asOf, windowDays: 90, excludeAllAsDemo: true,
    });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.fallback?.excludedDemoOrSimulation, 5);
  });
});