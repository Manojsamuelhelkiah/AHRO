/**
 * A reserved, server-created marker for demo reset samples.
 *
 * This marker is authoritative for reset and full-coverage samples. Those are
 * the only server-created paths allowed to write it, so mutable contact/name
 * fields must not participate in the decision: editing an offline sample must
 * never reactivate providers.
 */
export const SYNTHETIC_OFFLINE_MARKER = "[synthetic-offline-reset:v1]";
/** @deprecated UAT isolation is identified by `scenarioKey`, never notes. */
export const UAT_RUN_ISOLATED_MARKER = "[uat-run-isolated:v1]";

export type SyntheticOfflineCase = {
  notes: string | null;
  workerName?: string;
  workerEmail?: string;
  workerPhone?: string | null;
  scenarioKey?: string | null;
};

export function isSyntheticOfflineCase(
  row: SyntheticOfflineCase,
): boolean {
  return row.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true ||
    isUatRunIsolatedCase(row);
}

export function isUatRunIsolatedCase(row: SyntheticOfflineCase): boolean {
  return typeof row.scenarioKey === "string" && row.scenarioKey.startsWith("UAT-");
}

export const SYNTHETIC_OFFLINE_WARNING =
  "Synthetic sample is paused offline: no orchestration, provider dispatch, outreach, or readiness completion has run.";