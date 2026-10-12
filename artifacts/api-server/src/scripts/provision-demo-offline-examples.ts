// Explicit developer-only one-off exception. Never imported by the application.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, pool, onbCases, onbApprovals, onbCommunications, onbEvents } from "@workspace/db";
import { acquireOfflineExampleInventoryLock, provisionOfflineExamplesInTransaction, OFFLINE_EXAMPLE_CONFIRMATION } from "../lib/onboarding/offline-case-examples";
import { OFFLINE_CASE_EXAMPLES } from "../lib/onboarding/offline-example-inventory";
import { withCaseDispatchGuard } from "../lib/onboarding/dispatch-guard";
import { resumeChecklistOrchestration } from "../lib/onboarding/engine";
import { verifyDecisionAuthorityInTransaction } from "../lib/onboarding/decision-authority";

try {
  if (process.env.NODE_ENV !== "development" ||
      process.argv[2] !== OFFLINE_EXAMPLE_CONFIRMATION) {
    throw new Error("Run only in development with the explicit Demo offline-inventory confirmation.");
  }
  const result = await db.transaction(async tx => {
    await acquireOfflineExampleInventoryLock(tx);
    // Hold existing parents stable during this short additive operation. This
    // does not change their IDs, evidence, file references or other fields.
    const before = await tx.select().from(onbCases).where(eq(onbCases.organizationId, "demo")).for("share");
    const report = await provisionOfflineExamplesInTransaction(tx, "demo", OFFLINE_EXAMPLE_CONFIRMATION);
    const after = new Map((await tx.select().from(onbCases).where(eq(onbCases.organizationId, "demo"))).map(row => [row.id, row]));
    for (const row of before) assert.deepEqual(after.get(row.id), row, "Existing case changed");
    const oldIds = new Set(before.map(row => row.id));
    const added = [...after.values()].filter(row => !oldIds.has(row.id));
    assert.equal(added.length, report.created);
    assert.ok(added.every(row => row.organizationId === "demo"));
    return { ...report, unchangedExistingCases: before.length };
  });
  const examples = await db.select().from(onbCases).where(inArray(onbCases.scenarioKey, OFFLINE_CASE_EXAMPLES.map(item => item.key)));
  assert.equal(examples.length, 60);
  assert.ok(examples.every(row => row.organizationId === "demo"));
  let providerDenials = 0;
  let workerDenials = 0;
  let authorityDenials = 0;
  for (const row of examples) {
    let dispatched = false;
    await withCaseDispatchGuard(row.id, async () => { dispatched = true; });
    assert.equal(dispatched, false);
    providerDenials++;
    if (row.hireType === "offboarding") {
      await assert.rejects(resumeChecklistOrchestration(row.id), {
        message: "Separation and legacy exit requests cannot enter onboarding orchestration.",
      });
    } else {
      assert.equal(await resumeChecklistOrchestration(row.id), false);
    }
    workerDenials++;
    const authority = await db.transaction(tx => verifyDecisionAuthorityInTransaction(tx, {
      organizationId: "demo",
      actorUserId: "offline-example-boundary-probe",
      // A local probe only: no approval row or identity grant is persisted.
      approval: { caseId: row.id, authorityScope: "hr-compliance-approve" } as typeof onbApprovals.$inferSelect,
    }));
    assert.equal(authority.allowed, false);
    assert.equal(authority.reason, "case_operations_retired");
    authorityDenials++;
  }
  const ids = examples.map(row => row.id);
  for (const table of [onbApprovals, onbCommunications, onbEvents]) {
    assert.equal((await db.select({ id: table.id }).from(table).where(inArray(table.caseId, ids))).length, 0);
  }
  process.stdout.write(`${JSON.stringify({ workspace: "Demo", environment: "development", ...result, providerDenials, workerDenials, authorityDenials })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Offline example provisioning failed."}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
