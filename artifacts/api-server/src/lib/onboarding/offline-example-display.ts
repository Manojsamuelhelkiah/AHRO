import { isSyntheticOfflineCase } from "./synthetic-offline";
import type { OnbSyntheticProvenance } from "@workspace/db/schema";
import { originalDemoFullCoverageScenarioKey } from "./demo-full-coverage";
import { getScenario } from "./scenarios";
import { isRetiredControllerCase } from "./controller-retirement";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";

/**
 * Fictional read projection only; never used as execution or authority eligibility.
 * Unlike legacy creator predicates, retirement and UAT prefixes do not suppress
 * viewing a server-owned example. Real/hybrid contacts remain excluded.
 */
export function isFictionalOfflineExampleCase(row: {
  organizationId: string;
  syntheticProvenance?: OnbSyntheticProvenance | null;
  scenarioKey?: string | null;
  notes: string | null;
  workerEmail: string;
  workerName?: string;
  workerPhone: string | null;
  candidateEmailAuthorizedAt: Date | null;
  candidateEmailAuthorizedBy: string | null;
}) {
  // Older canonical coverage rows predate the durable provenance column.
  // Recognize only their reserved server-owned key AND exact fixed fictional
  // identity, never arbitrary notes, a generic UAT key, or a real contact.
  const legacyKey = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const legacyScenario = legacyKey ? getScenario(legacyKey) : undefined;
  const canonicalLegacyIdentity = legacyScenario != null &&
    row.workerName === `Demo sample — ${legacyScenario.title}` &&
    row.workerEmail === `demo-${legacyKey}@hro.invalid`;
  return row.organizationId === "demo" &&
    (row.syntheticProvenance != null || canonicalLegacyIdentity) &&
    isSyntheticOfflineCase(row) &&
    /^[^@\s]+@(?:[a-z0-9-]+\.)*invalid$/i.test(row.workerEmail) &&
    row.workerPhone === null &&
    row.candidateEmailAuthorizedAt === null &&
    row.candidateEmailAuthorizedBy === null;
}

/** Reporting inclusion never removes the independent controller-history fence. */
export function isReportableFictionalOfflineExampleCase(
  row: Parameters<typeof isFictionalOfflineExampleCase>[0] &
    Parameters<typeof isRetiredControllerCase>[0],
) {
  const legacyKey = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const knownInventory = Boolean(legacyKey && getScenario(legacyKey)) ||
    CURATED_OFFLINE_EXAMPLES.some(example => example.key === row.scenarioKey);
  // Inventory rows also carry the generic retirement flag. It is not proof of
  // controller ownership; preserve the independent provenance/state checks.
  return knownInventory && !isRetiredControllerCase({ ...row, controllerRetired: false }) &&
    isFictionalOfflineExampleCase(row);
}
