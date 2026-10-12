import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateNextCaseExchange, restartCaseSimulation, listSimulationEmailRoutes, recordSimulationEmailReply, sanitizeSimulationReply } from "./case-simulation";
test("stale progression and restart calls never mutate retained generations", async () => {
  for (const organizationId of ["demo", "client"]) {
    const input = { organizationId, actor: "administrator", caseId: 1, expectedVersion: 0, expectedGenerationId: "old", requestId: "retry" };
    await assert.rejects(simulateNextCaseExchange(input), { name: "RetiredCaseCapabilityError", status: 410 });
    await assert.rejects(restartCaseSimulation(input), { name: "RetiredCaseCapabilityError", status: 410 });
  }
});
test("pending reply routes are unenrolled without writing or manufacturing outcomes", async () => {
  assert.deepEqual(await listSimulationEmailRoutes(), []);
  assert.equal(await recordSimulationEmailReply({ organizationId: "demo", caseId: 1, fromAddress: "test@example.invalid", subject: "old", body: "approved", token: "old", threadMarker: "old", externalMessageId: "old" }), "ignored");
});
test("historical email sanitation remains intact", () => {
  assert.equal(sanitizeSimulationReply("<b>yes</b><script>alert(1)</script>"), "yes");
});
