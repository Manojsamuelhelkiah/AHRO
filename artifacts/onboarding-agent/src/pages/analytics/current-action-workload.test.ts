import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCurrentActions } from "./current-action-workload";
import type { OnbCase } from "@workspace/api-client-react";

const a = (key: string, label: string, status: NonNullable<OnbCase["currentAction"]>["status"]) => ({
  currentAction: { key, label, status, source: "workstream" as const, additionalCount: 0 },
});
test("groups by key and label, reconciles, excludes offline", () => {
  const s = summarizeCurrentActions([a("k", "X", "pending"), a("k", "X", "blocked"), a("k", "Y", "in-progress"), {}, { offlineSample: true, ...a("k", "X", "pending") }]);
  assert.equal(s.rows.length, 2);
  assert.equal(s.recorded + s.unknown + s.excluded, s.total);
  assert.equal(s.excluded, 1);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.rows[0], { key: "k", label: "X", pending: 1, inProgress: 0, blocked: 1 });
});

test("counts cases once, recomputes changed actions and excludes independent fictional markers", () => {
  const item = a("k", "Course prerequisite review", "pending");
  item.currentAction.additionalCount = 5;
  const s = summarizeCurrentActions([item, { fictionalOfflineIdentity: true, ...a("k", "X", "blocked") }]);
  assert.equal(s.recorded, 1);
  assert.equal(s.excluded, 1);
  assert.equal(s.total, 2);
  const updated = summarizeCurrentActions([a("next", "Confirm enrolment", "in-progress")]);
  assert.equal(updated.rows.length, 1);
  assert.equal(updated.rows[0].label, "Confirm enrolment");
  assert.equal(updated.rows[0].inProgress, 1);
  assert.equal(summarizeCurrentActions([]).total, 0);
});
