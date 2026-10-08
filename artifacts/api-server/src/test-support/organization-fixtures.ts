import { inArray, type SQL } from "drizzle-orm";
import { db, organizationsTable, hroContextAnchors, hroContextTransactions, hroContextSteps } from "@workspace/db";

/**
 * Test-only fixture teardown. Production organization deletion remains
 * restricted by its foreign keys; do not weaken that boundary for tests.
 */
export async function deleteTestOrganizations(predicate: SQL | undefined) {
  if (!predicate) throw new Error("Test organization cleanup requires an explicit scope");
  return db.transaction(async tx => {
    const organizations = await tx.select({ id: organizationsTable.id })
      .from(organizationsTable).where(predicate).for("update");
    const ids = organizations.map(organization => organization.id);
    if (!ids.length) return;
    await tx.delete(hroContextSteps).where(inArray(hroContextSteps.organizationId, ids));
    await tx.delete(hroContextTransactions).where(inArray(hroContextTransactions.organizationId, ids));
    await tx.delete(hroContextAnchors).where(inArray(hroContextAnchors.organizationId, ids));
    await tx.delete(organizationsTable).where(inArray(organizationsTable.id, ids));
  });
}
