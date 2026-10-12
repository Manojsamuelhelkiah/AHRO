import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewPolicyBenchmark, runPolicyBenchmark, configurePolicyDrift } from "./hr-policy-evaluation";
test("retired benchmark reviews, offline runs and live runs cannot approve, claim budget or dispatch", async () => {
  for (const organizationId of ["demo", "client", "other-tenant"]) {
    for (const actor of ["owner", "verified-reviewer", "member"]) {
      await assert.rejects(reviewPolicyBenchmark(organizationId, actor, { decision: "approved" }), { name: "RetiredCaseCapabilityError", status: 410 });
      for (const mode of ["offline", "live"]) {
        let calls = 0;
        await assert.rejects(runPolicyBenchmark(organizationId, actor, { mode, requestId: "retry", employeeId: 1 }, async () => {
          calls++; throw new Error("must not call a provider");
        }), { name: "RetiredCaseCapabilityError", status: 410 });
        assert.equal(calls, 0);
      }
      await assert.rejects(configurePolicyDrift(organizationId, actor, { enabled: true }), { name: "RetiredCaseCapabilityError", status: 410 });
    }
  }
});
