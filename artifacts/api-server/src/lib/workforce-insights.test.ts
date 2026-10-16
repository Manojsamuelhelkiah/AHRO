import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyWorkforceState, createHumanWorkforceReview, updateWorkforceReview,
  applyWorkforceModelAssessment, currentWorkforceBand, validDateOnly,
  type WorkforceAssessment, type WorkforceModelContract,
} from "./workforce-insights";

const now = new Date("2026-10-16T09:00:00Z");
const input = {
  version: 0, caseId: 41, kind: "talent-risk" as const, priority: "critical" as const,
  reason: "Unresolved mobility request", recommendedAction: "Arrange a supportive HR conversation",
  ownerUserId: "client-admin", dueDate: "2026-10-19",
};
const model: WorkforceModelContract = {
  id: "fixture-only-model", version: "1", kind: "talent-risk", validationStatus: "validated",
  validationReference: "fixture-only-validation", horizonDays: 90,
};
const assessment: WorkforceAssessment = {
  id: "fixture-result", caseId: 41, kind: "talent-risk", band: "red",
  modelId: model.id, modelVersion: model.version,
  assessedAt: now.toISOString(), validUntil: "2026-10-17T09:00:00Z", sourceRevision: "source-1",
  horizonDays: 90, probability: 0.7, factors: ["Source-backed fixture factor"],
  recommendedActions: ["Human follow-up required"],
};

test("human review persists ownership and history without creating a model prediction", () => {
  const initial = emptyWorkforceState();
  const created = createHumanWorkforceReview(initial, input, "admin", now);
  assert.equal(created.version, 1);
  assert.equal(created.assessments.length, 0);
  const review = created.reviews[0];
  assert.equal(review.origin, "human");
  assert.equal(review.assessmentId, null);
  assert.match(review.reference, /^EW-/);
  assert.equal(initial.reviews.length, 0);
  assert.equal(createHumanWorkforceReview(created, { ...input, version: 1 }, "admin", now), created);
  const updated = updateWorkforceReview(created, review.id, {
    version: 1, status: "resolved", ownerUserId: input.ownerUserId,
    dueDate: input.dueDate, outcome: "Employee received the requested information",
  }, "admin", now);
  assert.equal(updated.reviews[0].status, "resolved");
  assert.equal(updated.reviews[0].history.length, 2);
  assert.equal(created.reviews[0].status, "open");
});

test("both review kinds are independent and closed reviews cannot create duplicate open work", () => {
  const first = createHumanWorkforceReview(emptyWorkforceState(), input, "admin", now);
  const second = createHumanWorkforceReview(first, { ...input, version: 1, kind: "resume-integrity" }, "admin", now);
  assert.equal(second.reviews.length, 2);
  const closed = updateWorkforceReview(second, first.reviews[0].id, {
    version: 2, status: "dismissed", ownerUserId: input.ownerUserId, dueDate: input.dueDate, outcome: "Concern clarified",
  }, "admin", now);
  const reopened = createHumanWorkforceReview(closed, { ...input, version: 3 }, "admin", now);
  assert.throws(() => updateWorkforceReview(reopened, first.reviews[0].id, {
    version: 4, status: "open", ownerUserId: input.ownerUserId, dueDate: input.dueDate, outcome: "",
  }, "admin", now), /already open/);
});

test("stale saves, invalid dates, blank concerns and unexplained closures fail explicitly", () => {
  assert.equal(validDateOnly("2026-02-30"), false);
  assert.equal(validDateOnly("2028-02-29"), true);
  for (const patch of [{ version: 0.5 }, { caseId: 0.5 }, { reason: " " }, { dueDate: "2026-02-30" }]) {
    assert.throws(() => createHumanWorkforceReview(emptyWorkforceState(), { ...input, ...patch }, "admin", now));
  }
  const state = createHumanWorkforceReview(emptyWorkforceState(), input, "admin", now);
  assert.throws(() => createHumanWorkforceReview(state, input, "admin", now), /Reload/);
  assert.throws(() => updateWorkforceReview(state, state.reviews[0].id, {
    version: 1, status: "resolved", ownerUserId: input.ownerUserId, dueDate: input.dueDate, outcome: " ",
  }, "admin", now), /outcome/);
});

test("disconnected, stale, future, wrong-source or wrong-version assessments remain unknown", () => {
  assert.equal(currentWorkforceBand(undefined, "source-1", undefined, now), "unknown");
  assert.equal(currentWorkforceBand(assessment, "source-1", undefined, now), "unknown");
  assert.equal(currentWorkforceBand(assessment, "changed-source", model, now), "unknown");
  assert.equal(currentWorkforceBand(assessment, "source-1", { ...model, version: "2" }, now), "unknown");
  assert.equal(currentWorkforceBand({ ...assessment, validUntil: now.toISOString() }, "source-1", model, now), "unknown");
  assert.equal(currentWorkforceBand({ ...assessment, assessedAt: "2026-10-18T00:00:00Z" }, "source-1", model, now), "unknown");
  assert.equal(currentWorkforceBand({ ...assessment, validUntil: "invalid" }, "source-1", model, now), "unknown");
  assert.equal(currentWorkforceBand(assessment, "source-1", model, now), "red");
});

test("future validated red adapter creates one critical human-action review and replays are idempotent", () => {
  const state = applyWorkforceModelAssessment(emptyWorkforceState(), assessment, model, "source-1", "admin", now);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].origin, "model");
  assert.equal(state.reviews[0].priority, "critical");
  assert.equal(state.reviews[0].status, "open");
  assert.equal(state.reviews[0].assessmentId, assessment.id);
  assert.equal(applyWorkforceModelAssessment(state, assessment, model, "source-1", "admin", now), state);
  const next = applyWorkforceModelAssessment(state, {
    ...assessment, id: "next", assessedAt: "2026-10-16T09:01:00Z",
  }, model, "source-1", "admin", new Date("2026-10-16T09:02:00Z"));
  assert.equal(next.reviews.length, 1);
  assert.equal(next.reviews[0].assessmentId, "next");
  assert.equal(next.reviews[0].history.length, 2);
  assert.throws(() => applyWorkforceModelAssessment(next, {
    ...assessment, id: "late",
  }, model, "source-1", "admin", now), /newer assessment/);
});

test("green and amber model fixtures never manufacture critical cases", () => {
  for (const band of ["green", "amber"] as const) {
    const state = applyWorkforceModelAssessment(emptyWorkforceState(), { ...assessment, band }, model, "source-1", "admin", now);
    assert.equal(state.reviews.length, 0);
    assert.equal(state.assessments[0].band, band);
  }
  assert.throws(() => applyWorkforceModelAssessment(emptyWorkforceState(), {
    ...assessment, probability: 2,
  }, model, "source-1", "admin", now), /probability/);
});
