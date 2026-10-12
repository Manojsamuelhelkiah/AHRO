import { isSyntheticOfflineCase } from "./synthetic-offline";
import type { OnbSyntheticProvenance } from "@workspace/db/schema";
import { originalDemoFullCoverageScenarioKey } from "./demo-full-coverage";
import { getScenario } from "./scenarios";

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
