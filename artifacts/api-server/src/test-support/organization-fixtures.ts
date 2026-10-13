import { inArray, type SQL } from "drizzle-orm";
import { db, pool, organizationsTable, hroContextAnchors, hroContextTransactions, hroContextSteps, hroContextRetentionPolicies, hroContextRetentionState } from "@workspace/db";

/** Prevent a directly invoked/bundled workspace suite from bypassing its runner. */
export async function requireOwnedOrganizationTestSchema(): Promise<void> {
  const { rows } = await pool.query("SELECT current_schema() s, current_schemas(false)::text[] scopes");
  const scope = rows[0];
  if (!/^workspace_regression_[0-9]+_[a-f0-9]+$/.test(scope?.s ?? "") ||
      !Array.isArray(scope.scopes) || scope.scopes.length !== 1) {
    throw new Error("Workspace regression requires the owned isolated run-tests.mjs harness");
  }
}

/**
 * Test-only fixture teardown. Production organization deletion remains
 * restricted by its foreign keys; do not weaken that boundary for tests.
 */
export async function deleteTestOrganizations(
  predicate: SQL | undefined,
  cleanup?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], ids: string[]) => Promise<void>,
) {
  if (!predicate) throw new Error("Test organization cleanup requires an explicit scope");
  return db.transaction(async tx => {
    const organizations = await tx.select({ id: organizationsTable.id })
      .from(organizationsTable).where(predicate).for("update");
    const ids = organizations.map(organization => organization.id);
    if (!ids.length) return;
     if (ids.some(id => id === "demo" || id === "platform-audit" || id === "org_654eb2bb-23cb-489a-9cc3-50faeddcfd3c")) {
       throw new Error("Test teardown cannot remove a protected workspace");
     }
    // Keep bootstrap children and the parent deletion under the same FK lock.
    if (cleanup) await cleanup(tx, ids);
    await tx.delete(hroContextRetentionState).where(inArray(hroContextRetentionState.organizationId, ids));
    await tx.delete(hroContextRetentionPolicies).where(inArray(hroContextRetentionPolicies.organizationId, ids));
    await tx.delete(hroContextSteps).where(inArray(hroContextSteps.organizationId, ids));
    await tx.delete(hroContextTransactions).where(inArray(hroContextTransactions.organizationId, ids));
    await tx.delete(hroContextAnchors).where(inArray(hroContextAnchors.organizationId, ids));
    await tx.delete(organizationsTable).where(inArray(organizationsTable.id, ids));
  });
}
