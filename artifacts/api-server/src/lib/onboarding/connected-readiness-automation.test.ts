import assert from "node:assert/strict";
import { test } from "node:test";
import { runConnectedReadinessWorkers } from "./connected-readiness-automation";

test("a failed SLA worker does not starve independent early-tenure delivery", async () => {
  let earlyTenureRan = false;
  await assert.rejects(runConnectedReadinessWorkers({
    auditAnchor: async () => {},
    auditReviewerAlert: async () => {},
    readinessSla: async () => { throw new Error("legacy jurisdiction missing"); },
    earlyTenure: async () => { earlyTenureRan = true; },
    approvalNotifications: async () => {},
  }), AggregateError);
  assert.equal(earlyTenureRan, true);
});