import { eq, inArray } from "drizzle-orm";
import { onbCases, organizationsTable } from "@workspace/db";
import type { OnboardingDbTransaction } from "./settings";
import { controlTowerInventorySlots, eligibleControlTowerExample } from "./control-tower-examples";
import { acquireOfflineExampleInventoryLock, provisionOfflineExampleReadAccess, OFFLINE_EXAMPLE_CONFIRMATION } from "./offline-case-examples";
import { actualRunOwnedCaseIds } from "./offline-preparation";
import { templateOriginalIntent } from "./original-intent";

export const CONTROL_TOWER_PROVISION_CONFIRMATION = "add-only-missing-control-tower-examples-to-demo";

/** Developer-only additive exception. No HTTP/startup import, effects or telemetry writes. */
export async function provisionControlTowerExamples(tx: OnboardingDbTransaction, org: string, confirmation: string) {
  if (process.env.NODE_ENV !== "development" || org !== "demo" ||
    confirmation !== CONTROL_TOWER_PROVISION_CONFIRMATION) throw new Error("Explicit development Demo provisioning confirmation required.");
  await acquireOfflineExampleInventoryLock(tx);
  const [tenant] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, org)).for("share");
  if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") throw new Error("Demo workspace identity could not be verified.");
  const slots = controlTowerInventorySlots();
  // Global lookup rejects copied reserved identities in any client.
  const existing = await tx.select().from(onbCases).where(inArray(onbCases.scenarioKey, slots.map(s => s.key))).for("share");
  const actual = await actualRunOwnedCaseIds(tx, org, existing.map(r => r.id));
  for (const slot of slots) {
    const rows = existing.filter(r => r.scenarioKey === slot.key);
    if (rows.length > 1 || (rows.length === 1 && !eligibleControlTowerExample(rows[0], actual.has(rows[0].id)))) {
      throw new Error("Reserved example is duplicated, changed, prepared, activated or run-owned; no overlay or replacement is permitted.");
    }
  }
  const missing = slots.filter(s => !existing.some(r => r.scenarioKey === s.key));
  const inserted = missing.length ? await tx.insert(onbCases).values(missing.map(s => ({
    organizationId: org, ...s.values,
    originalIntent: templateOriginalIntent(s.values.processPolicySnapshot.batchIntake.templateId, "curated-fictional-intake"),
  }))).returning() : [];
  const rows = [...existing, ...inserted];
  // Restrict the established inventory read-grant procedure to these exact slots.
  const readGrantsCreated = inserted.length
    ? await provisionOfflineExampleReadAccess(tx, org, OFFLINE_EXAMPLE_CONFIRMATION, inserted.map(r => r.id)) : 0;
  return { created: inserted.length, reused: existing.length, readGrantsCreated,
    cases: rows.map(r => ({ id: r.id, reference: `S${r.id}` })) };
}
