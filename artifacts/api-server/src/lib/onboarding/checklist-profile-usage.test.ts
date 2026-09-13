import assert from "node:assert/strict";
import test from "node:test";
import { summarizeChecklistProfileUsage } from "./checklist-profile-usage";

test("summarizes recent snapshot usage across profile versions", () => {
  const result = summarizeChecklistProfileUsage([
    { checklistProfileId: "profile-a", createdAt: new Date("2026-09-12T00:00:00.000Z") },
    { checklistProfileId: "profile-a", createdAt: new Date("2026-08-01T00:00:00.000Z") },
    { checklistProfileId: "profile-a", createdAt: new Date("2025-01-01T00:00:00.000Z") },
    { checklistProfileId: "default", createdAt: new Date("2026-09-10T00:00:00.000Z") },
  ], new Date("2026-09-13T00:00:00.000Z"), 90);

  assert.equal(result.recentCaseCount, 3);
  assert.equal(result.defaultFallbackCount, 1);
  assert.equal(result.defaultFallbackRate, 1 / 3);
  assert.deepEqual(result.profiles, [{
    profileId: "profile-a",
    recentMatchedCaseCount: 2,
    lastUsedAt: "2026-09-12T00:00:00.000Z",
  }]);
});

test("returns a zero fallback rate for an empty cohort", () => {
  const result = summarizeChecklistProfileUsage([], new Date("2026-09-13T00:00:00.000Z"), 90);
  assert.equal(result.defaultFallbackRate, 0);
  assert.equal(result.defaultFallbackCount, 0);
});