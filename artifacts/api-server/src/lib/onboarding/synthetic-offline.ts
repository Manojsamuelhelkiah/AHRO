/**
 * A reserved, server-created marker for demo reset samples.
 *
 * This marker is authoritative.  The reset is the only server-created path
 * allowed to write it, so mutable contact/name fields must not participate in
 * the decision: editing an offline sample must never reactivate providers.
 */
export const SYNTHETIC_OFFLINE_MARKER = "[synthetic-offline-reset:v1]";

export type SyntheticOfflineCase = {
  notes: string | null;
  workerName?: string;
  workerEmail?: string;
  workerPhone?: string | null;
};

export function isSyntheticOfflineCase(
  row: SyntheticOfflineCase,
): boolean {
  return row.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true;
}

export const SYNTHETIC_OFFLINE_WARNING =
  "Synthetic sample is paused offline: no orchestration, provider dispatch, outreach, or readiness completion has run.";