import test from "node:test";
import assert from "node:assert/strict";
import { statusOf } from "./index";

test("statusOf maps completed lifecycle to Completed", () => {
  assert.equal(statusOf({ lifecycleStage: "completed", orchestrationStatus: "idle" }), "Completed");
});

test("statusOf maps blocked orchestration to Blocked (before waiting fallthrough)", () => {
  assert.equal(statusOf({ lifecycleStage: "in-progress", orchestrationStatus: "blocked" }), "Blocked");
  assert.equal(statusOf({ lifecycleStage: "exception", orchestrationStatus: "idle" }), "Blocked");
  assert.equal(statusOf({ lifecycleStage: "exception", orchestrationStatus: "blocked" }), "Blocked");
});

test("statusOf maps waiting-approval to Human Review", () => {
  assert.equal(statusOf({ lifecycleStage: "profile-validated", orchestrationStatus: "waiting-approval" }), "Human Review");
});

test("statusOf maps trigger-received to New", () => {
  assert.equal(statusOf({ lifecycleStage: "trigger-received", orchestrationStatus: "idle" }), "New");
});

test("statusOf maps running to In Progress and idle mid-stage to Waiting", () => {
  assert.equal(statusOf({ lifecycleStage: "profile-validated", orchestrationStatus: "running" }), "In Progress");
  assert.equal(statusOf({ lifecycleStage: "preboarding", orchestrationStatus: "idle" }), "Waiting");
});
