import { and, eq, inArray } from "drizzle-orm";
import { controlTowerInventorySlots, eligibleControlTowerExample } from "./src/lib/onboarding/control-tower-examples.ts";

/** Owned disposable test-schema data only; never imported by the application. */
export async function seedControlTowerBrowserFixture(database, schema, actor) {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_E2E_TEST !== "true" ||
    !schema?.startsWith("browser_regression_")) {
    throw new Error("Control Tower browser fixtures require an owned isolated test schema.");
  }
  const { db, onbCases, accessNamedGrants } = database;
  await db.transaction(async tx => {
    const scope = await tx.execute("select current_schema() as name");
    if (scope.rows[0]?.name !== schema) throw new Error("Browser fixture schema mismatch.");
    const slots = controlTowerInventorySlots();
    const rows = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, "demo"),
      inArray(onbCases.scenarioKey, slots.map(s => s.key))));
    const ids = [];
    for (const slot of slots) {
      const found = rows.filter(r => r.scenarioKey === slot.key);
      if (found.length > 1 || (found[0] && !eligibleControlTowerExample(found[0]))) {
        throw new Error("Browser fixture refuses to overlay an altered example.");
      }
      const row = found[0] ?? (await tx.insert(onbCases).values({ organizationId: "demo", ...slot.values }).returning())[0];
      ids.push(row.id);
    }
    // Read access only. No consent, provider records, tasks, decisions or
    // genuine telemetry are created for these illustrative records.
    await tx.insert(accessNamedGrants).values(ids.flatMap(caseId =>
      ["flow.case.read", "data.case.profile.read", "data.case.notes.read", "data.case.readiness.read"].map(resourceKey => ({
        organizationId: "demo", principalType: "human", principalId: actor, scope: "case", caseId,
        resourceType: resourceKey.startsWith("flow.") ? "flow" : "field", resourceKey,
        source: "named", effect: "allow", createdByUserId: actor,
      }))));
  });
}
