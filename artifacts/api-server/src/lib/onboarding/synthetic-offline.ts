import type { OnbSyntheticProvenance } from "@workspace/db/schema";

/**
 * A reserved, server-created marker for demo reset samples.
 *
 * Marker text is mutable and may also appear in untrusted notes. It only
 * identifies an offline case when paired with the durable server-owned
 * provenance field; UAT isolation uses its scenario key instead.
 */
export const SYNTHETIC_OFFLINE_MARKER = "[synthetic-offline-reset:v1]";
export const SYNTHETIC_DEMO_AUTHORITY_SOURCE = "synthetic-demo-bootstrap";
/** @deprecated UAT isolation is identified by `scenarioKey`, never notes. */
export const UAT_RUN_ISOLATED_MARKER = "[uat-run-isolated:v1]";

const SYNTHETIC_OFFLINE_PROVENANCE = new Set<OnbSyntheticProvenance>([
  "onboarding-demo-fictional",
  "synthetic-reset",
  "demo-full-coverage",
  "demo-controller-fictional",
]);

export type SyntheticOfflineCase = {
  notes: string | null;
  syntheticProvenance?: OnbSyntheticProvenance | null;
  workerName?: string;
  workerEmail?: string;
  workerPhone?: string | null;
  scenarioKey?: string | null;
};

export function isSyntheticOfflineCase(
  row: SyntheticOfflineCase,
): boolean {
  return isUatRunIsolatedCase(row) || (
    row.syntheticProvenance != null &&
    SYNTHETIC_OFFLINE_PROVENANCE.has(row.syntheticProvenance) &&
    row.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true
  );
}

export function isUatRunIsolatedCase(row: SyntheticOfflineCase): boolean {
  return typeof row.scenarioKey === "string" && row.scenarioKey.startsWith("UAT-");
}

export function isSyntheticDemoAuthority(input: {
  organizationId: string;
  caseRow: SyntheticOfflineCase;
  source: string;
}): boolean {
  return input.organizationId === "demo" &&
    input.source === SYNTHETIC_DEMO_AUTHORITY_SOURCE &&
    isSyntheticOfflineCase(input.caseRow);
}

export const SYNTHETIC_OFFLINE_WARNING =
  "Synthetic sample is paused offline: no orchestration, provider dispatch, outreach, or readiness completion has run.";