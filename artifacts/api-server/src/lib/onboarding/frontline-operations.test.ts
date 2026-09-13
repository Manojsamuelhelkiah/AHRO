import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FrontlineValidationError,
  parseFrontlinePolicy,
} from "./frontline-operations";
import { AUTHORITY_ROLES, AUTHORITY_SCOPES, roleMayExerciseScope } from "./decision-authority";

const reviewedPolicy = {
  processPolicy: {
    frontline: {
      schemaVersion: "frontline-operations/v1",
      age: { minimumYears: 18 },
      fulfillment: { requiredItems: ["badge", "ppe", "uniform", "tool", "locker"] },
      statutory: {
        requirements: [{
          key: "state-wage-registration",
          jurisdiction: "IN-KA",
          effectiveFrom: "2025-01-01T00:00:00.000Z",
          policyReference: "POL-422",
          reviewReference: "LEGAL-REVIEW-422",
        }],
      },
      exceptions: {
        policyReference: "POL-422",
        reviewReference: "HSE-REVIEW-422",
        permitted: ["substitution"],
      },
    },
  },
};

describe("frontline immutable policy parser", () => {
  test("registers a least-privilege safety authority distinct from occupational health", () => {
    assert.equal(AUTHORITY_ROLES.includes("safety"), true);
    assert.equal(AUTHORITY_SCOPES.includes("safety-approve"), true);
    assert.equal(roleMayExerciseScope("safety", "safety-approve"), true);
    assert.equal(roleMayExerciseScope("occupational-health", "safety-approve"), false);
  });

  test("fails closed rather than inventing statutory requirements", () => {
    assert.throws(
      () => parseFrontlinePolicy({ processPolicy: { frontline: { schemaVersion: "frontline-operations/v1" } } }),
      FrontlineValidationError,
    );
    assert.throws(
      () => parseFrontlinePolicy({}),
      /explicit immutable frontline policy review/i,
    );
  });

  test("retains the only jurisdiction/effective dates explicitly reviewed", () => {
    const policy = parseFrontlinePolicy(reviewedPolicy);
    assert.deepEqual(policy.statutoryRequirements, [{
      key: "state-wage-registration",
      jurisdiction: "IN-KA",
      effectiveFrom: "2025-01-01T00:00:00.000Z",
      policyReference: "POL-422",
      reviewReference: "LEGAL-REVIEW-422",
    }]);
    assert.equal(policy.statutoryRequirements.some((entry) => entry.jurisdiction === "IN-MH"), false);
  });

  test("requires an explicit reviewed exception policy even when no exception is allowed", () => {
    const noExceptionReview = structuredClone(reviewedPolicy);
    delete (noExceptionReview.processPolicy.frontline as any).exceptions;
    assert.throws(() => parseFrontlinePolicy(noExceptionReview), /immutable frontline policy is incomplete/i);

    const noExceptions = structuredClone(reviewedPolicy);
    noExceptions.processPolicy.frontline.exceptions.permitted = [];
    assert.deepEqual(parseFrontlinePolicy(noExceptions).exceptions.permitted, []);
  });
});