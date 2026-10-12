import { isRetiredControllerCase } from "./controller-retirement";

/**
 * Retirement classification, not a replacement for legacy offline predicates.
 * Server-owned provenance and reserved scenario keys survive content minimization.
 */
export function isHistoricalTestRecord(row: {
  scenarioKey?: string | null;
  syntheticProvenance?: string | null;
  controllerRetired?: boolean;
  notes?: string | null;
  candidateEmailAuthorizedBy?: string | null;
  checklistProfileId?: string | null;
  orchestrationCheckpoint?: string | null;
}): boolean {
  return row.syntheticProvenance != null ||
    row.scenarioKey != null ||
    isRetiredControllerCase(row);
}
