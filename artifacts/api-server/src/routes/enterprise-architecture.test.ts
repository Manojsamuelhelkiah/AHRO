import test from "node:test";
import assert from "node:assert/strict";
import {
  getEaMutationRejection,
  validateContentReferences,
} from "./enterprise-architecture.js";

function content(): Record<string, any> {
  return {
    phaseProgress: [],
    requirements: [],
    currentState: {
      business: [], data: [], application: [], technology: [], integration: [],
      ai: [], security: [], operatingModel: [],
    },
    gaps: [],
    targetArchitecture: { components: [], relationships: [] },
    opportunities: { solutionOptions: [], transitionArchitectures: [] },
    roadmap: { workPackages: [], waves: [], dependencies: [], prioritization: [] },
    governance: { contracts: [], reviews: [], deviations: [], waivers: [], remediation: [] },
    changeManagement: { requests: [], versionHistory: [] },
    decisions: [],
    risks: [],
    costLinks: [],
  };
}

function rejectsUnknown(mutator: (value: Record<string, any>) => void, label: RegExp) {
  const value = content();
  mutator(value);
  assert.throws(() => validateContentReferences(value), label);
}

test("dangling target relationship references remain rejected", () => {
  rejectsUnknown((value) => {
    value.targetArchitecture.relationships.push({
      id: "relationship-1",
      sourceComponentId: "missing-source",
      targetComponentId: "missing-target",
    });
  }, /targetArchitecture\.relationships references unknown id/);
});

test("dangling roadmap references remain rejected", () => {
  rejectsUnknown((value) => {
    value.roadmap.dependencies.push({
      id: "dependency-1",
      predecessorWorkPackageId: "missing-predecessor",
      successorWorkPackageId: "missing-successor",
    });
  }, /roadmap\.dependencies references unknown id/);
});

test("dangling governance-review traceability remains rejected", () => {
  rejectsUnknown((value) => {
    value.requirements.push({
      id: "requirement-1",
      traceability: {
        requirementIds: [],
        gapIds: [],
        targetComponentIds: [],
        workPackageIds: [],
        governanceReviewIds: ["missing-review"],
      },
    });
  }, /requirements\.traceability\.governanceReviewIds references unknown id/);
});

test("dangling version-history change requests remain rejected", () => {
  rejectsUnknown((value) => {
    value.changeManagement.versionHistory.push({
      id: "version-1",
      changeRequestIds: ["missing-change"],
    });
  }, /changeManagement\.versionHistory\.changeRequestIds references unknown id/);
});

for (const action of ["patch", "archive", "delete"] as const) {
  test(`stale ${action.toUpperCase()} returns 409 without changing content or version`, () => {
    const stored = {
      status: "active",
      version: 7,
      content: { requirements: [{ id: "newer-work" }] },
    };
    const before = structuredClone(stored);

    assert.deepEqual(getEaMutationRejection(stored, 6, action), {
      status: 409,
      error: "Assessment has changed; reload it and retry with its current expectedVersion",
    });
    assert.deepEqual(stored, before);
  });
}

for (const action of ["patch", "handoff", "delete"] as const) {
  test(`archived ${action} remains rejected`, () => {
    const archived = { status: "archived", version: 8 };
    const rejection = getEaMutationRejection(archived, 8, action);
    assert.equal(rejection?.status, 409);
    assert.match(rejection?.error ?? "", /Archived/);
  });
}