import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRiskExamples, eligibleRiskExampleSource, visibleRiskExamples, RISK_EXAMPLE_SOURCES } from "./workforce-risk-examples";
import { emptyWorkforceState, updateWorkforceReview } from "./workforce-insights";

const now = new Date("2026-10-16T09:00:00Z");
const sources = RISK_EXAMPLE_SOURCES.map((row, index) => ({
  ...row.values, id: index + 51, organizationId: "demo", updatedAt: now,
  candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
}));

test("three separate examples create supportive reviews but no model assessments or effects", () => {
  const result = buildRiskExamples(emptyWorkforceState(), sources, now);
  assert.deepEqual(result.examples.map(row => row.band), ["red", "amber", "green"]);
  assert.equal(result.state.reviews.length, 3);
  assert.equal(result.state.assessments.length, 0);
  assert.equal(result.state.reviews.filter(row => row.priority === "critical").length, 1);
  for (const review of result.state.reviews) {
    assert.match(review.reference, /^S\d+$/);
    assert.equal(review.origin, "catalogue");
    assert.equal(review.assessmentId, null);
    assert.ok(review.recommendedAction);
  }
  assert.equal(buildRiskExamples(result.state, sources, now).state, result.state);
  const review = result.state.reviews[0];
  const closed = updateWorkforceReview(result.state, review.id, {
    version: result.state.version, status: "resolved", outcome: "Progression plan agreed",
    ownerUserId: "current-admin", dueDate: review.dueDate,
  }, "current-admin", now);
  assert.equal(buildRiskExamples(closed, sources, now).state.reviews[0].status, "resolved");
});

test("examples fail closed for another tenant, identity, live contact, missing source or changed source", () => {
  const { examples } = buildRiskExamples(emptyWorkforceState(), sources, now);
  assert.equal(visibleRiskExamples("demo", examples, sources, now).length, 3);
  assert.deepEqual(visibleRiskExamples("client", examples, sources, now), []);
  assert.deepEqual(visibleRiskExamples("demo", examples, [], now), []);
  const source = sources[0];
  for (const patch of [{ organizationId: "client" }, { workerName: "Real person" },
    { workerEmail: "person@example.com" }, { syntheticProvenance: null }, { workerPhone: "+10000000000" },
    { candidateEmailAuthorizedAt: now }, { scenarioKey: "unrecognized" }]) {
    assert.equal(eligibleRiskExampleSource({ ...source, ...patch }), false);
  }
  assert.throws(() => buildRiskExamples(emptyWorkforceState(), sources.slice(1), now), /approved Demo source/);
  assert.equal(visibleRiskExamples("demo", examples, sources.map(row => ({ ...row, updatedAt: new Date(now.getTime() + 1) })), now).length, 0);
  assert.equal(visibleRiskExamples("demo", examples, sources, new Date(now.getTime() + 91 * 86_400_000)).length, 0);
});
