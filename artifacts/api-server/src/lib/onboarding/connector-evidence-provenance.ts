/**
 * Trusted-source predicates used by governance runtime gates.  They consume
 * persisted, server-classified facts only; status labels, references, and
 * timestamps without provenance are intentionally insufficient.
 */
export type ConnectorConfigurationFact = {
  status: string;
  lastSyncAt: Date | null;
  configurationProvenance: string | null;
};

export type SystemEvidenceFact = {
  system: string;
  status: string;
  mode: string;
  externalRef: string;
  completedAt: Date | null;
  evidenceProvenance: string | null;
};

export type HrisActivationEvidenceFact = {
  complete: boolean;
  evidenceProvenance: string | null;
};

export function hasTrustedProviderConfiguration(
  connector: ConnectorConfigurationFact | undefined,
): boolean {
  return connector?.status === "connected" &&
    connector.lastSyncAt !== null &&
    connector.configurationProvenance === "trusted-provider";
}

export function hasTrustedBgvClearanceEvidence(
  checks: readonly SystemEvidenceFact[],
): boolean {
  return checks.some((check) =>
    check.system === "bgv" &&
    check.status === "done" &&
    check.completedAt !== null &&
    check.externalRef.trim().length > 0 &&
    ["push", "poll", "email"].includes(check.mode) &&
    check.evidenceProvenance === "trusted-provider");
}

export function hasTrustedHrisActivationEvidence(
  attestation: HrisActivationEvidenceFact | undefined,
): boolean {
  return attestation?.complete === true &&
    attestation.evidenceProvenance === "trusted-provider";
}