import type { AuditIntegrity } from "./onboarding/protected-audit";

export type RegulatedProductionStartupEnvironment = {
  REGULATED_PRODUCTION_LAUNCH?: string;
  REGULATED_PRODUCTION_ORGANIZATION_IDS?: string;
};

export type RegulatedProductionStartupDependencies = {
  organizationExists: (organizationId: string) => Promise<boolean>;
  verifyProtectedAudit: (organizationId: string) => Promise<AuditIntegrity>;
};

/**
 * Parses the opt-in tenant list without applying any policy to ordinary
 * development, demo, or unregulated launches.
 */
export function regulatedProductionOrganizationIds(
  environment: RegulatedProductionStartupEnvironment,
): string[] {
  if (environment.REGULATED_PRODUCTION_LAUNCH !== "true") return [];
  const raw = environment.REGULATED_PRODUCTION_ORGANIZATION_IDS?.trim();
  if (!raw) {
    throw new Error(
      "REGULATED_PRODUCTION_ORGANIZATION_IDS is required when REGULATED_PRODUCTION_LAUNCH=true.",
    );
  }
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => !id)) {
    throw new Error(
      "REGULATED_PRODUCTION_ORGANIZATION_IDS must contain only non-empty comma-separated tenant IDs.",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("REGULATED_PRODUCTION_ORGANIZATION_IDS must not contain duplicate tenant IDs.");
  }
  return ids;
}

function externalArchiveFullyReady(integrity: AuditIntegrity): boolean {
  const archive = integrity.externalAnchoring;
  return integrity.status === "verified" &&
    archive.providerKind === "external" &&
    archive.configured &&
    archive.verified === true &&
    archive.comparison === "match" &&
    archive.configGeneration !== undefined &&
    archive.configGeneration > 0 &&
    archive.restoreDrillPassed === true &&
    archive.legalHoldDrillPassed === true &&
    archive.drillsInvalid === false &&
    archive.staleSnapshot === false &&
    archive.regulatedProductionLaunchBlocked === false;
}

/**
 * Fail-closed startup policy for the explicitly selected regulated tenants.
 *
 * The database lookup and verifier are injected so this policy remains pure
 * and directly testable without importing the server or opening a connection.
 */
export async function enforceRegulatedProductionStartupGuard(
  environment: RegulatedProductionStartupEnvironment,
  dependencies: RegulatedProductionStartupDependencies,
): Promise<void> {
  const organizationIds = regulatedProductionOrganizationIds(environment);
  for (const organizationId of organizationIds) {
    let exists: boolean;
    try {
      exists = await dependencies.organizationExists(organizationId);
    } catch (error) {
      throw new Error(
        `Regulated production startup could not verify organization "${organizationId}".`,
        { cause: error },
      );
    }
    if (!exists) {
      throw new Error(
        `Regulated production startup refused: organization "${organizationId}" does not exist.`,
      );
    }

    let integrity: AuditIntegrity;
    try {
      integrity = await dependencies.verifyProtectedAudit(organizationId);
    } catch (error) {
      throw new Error(
        `Regulated production startup could not verify protected audit for organization "${organizationId}".`,
        { cause: error },
      );
    }
    if (!externalArchiveFullyReady(integrity)) {
      throw new Error(
        `Regulated production startup refused for organization "${organizationId}": protected audit or external archive is not fully ready.`,
      );
    }
  }
}