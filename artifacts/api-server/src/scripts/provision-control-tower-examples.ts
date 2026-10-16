// Deliberate developer command only. Default is a read-only inventory check.
import { eq, inArray } from "drizzle-orm";
import { db, pool, onbCases, organizationsTable } from "@workspace/db";
import { controlTowerInventorySlots, eligibleControlTowerExample } from "../lib/onboarding/control-tower-examples";
import { CONTROL_TOWER_PROVISION_CONFIRMATION, provisionControlTowerExamples } from "../lib/onboarding/control-tower-example-provisioning";
import { actualRunOwnedCaseIds } from "../lib/onboarding/offline-preparation";
import { authoritativelyUatRunOwnedCaseIds } from "../lib/onboarding/uat-isolation";

try {
  if (process.env.NODE_ENV !== "development") throw new Error("This command is development-only.");
  const [tenant] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, "demo"));
  if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") throw new Error("Demo workspace identity could not be verified.");
  const slots = controlTowerInventorySlots();
  const rows = await db.select().from(onbCases).where(inArray(onbCases.scenarioKey, slots.map(s => s.key)));
  const [actual, uat] = await Promise.all([
    actualRunOwnedCaseIds(db, "demo", rows.map(r => r.id)),
    authoritativelyUatRunOwnedCaseIds("demo", rows),
  ]);
  if (process.argv[2] === CONTROL_TOWER_PROVISION_CONFIRMATION) {
    const result = await db.transaction(tx => provisionControlTowerExamples(tx, "demo", CONTROL_TOWER_PROVISION_CONFIRMATION));
    process.stdout.write(`${JSON.stringify({ workspace: "Demo Organization", ...result })}\n`);
  } else if (!process.argv[2] || process.argv[2] === "--check") {
    process.stdout.write(`${JSON.stringify({ workspace: "Demo Organization", mode: "read-only",
      intended: slots.length, slots: slots.map(s => {
        const matches = rows.filter(r => r.scenarioKey === s.key);
        return { family: s.family, key: s.key, count: matches.length,
          references: matches.map(r => `S${r.id}`),
          eligible: matches.length === 1 && eligibleControlTowerExample(matches[0], actual.has(matches[0].id) || uat.has(matches[0].id)) };
      }) })}\n`);
  } else throw new Error("Use --check or the explicit provisioning confirmation.");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Inventory verification failed."}\n`);
  process.exitCode = 1;
} finally { await pool.end(); }
