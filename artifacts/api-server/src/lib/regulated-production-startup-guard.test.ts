import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceRegulatedProductionStartupGuard,
  regulatedProductionOrganizationIds,
} from "./regulated-production-startup-guard";
import type { AuditIntegrity } from "./onboarding/protected-audit";

const readyIntegrity = {
  status: "verified",
  checkedEntries: 1,
  firstBrokenSequence: null,
  headMatches: true,
  externalAnchoring: {
    requiredForLaunch: true,
    providerId: "independent-archive",
    providerKind: "external",
    configured: true,
    verified: true,
    comparison: "match",
    regulatedProductionLaunchBlocked: false,
    restoreDrillPassed: true,
    legalHoldDrillPassed: true,
    drillsInvalid: false,
    staleSnapshot: false,
    configGeneration: 1,
    limitation: "ready",
  },
} satisfies AuditIntegrity;

test("regulated startup guard is inert unless explicitly enabled", async () => {
  let checked = false;
  await enforceRegulatedProductionStartupGuard(
    { REGULATED_PRODUCTION_LAUNCH: "false" },
    {
      organizationExists: async () => {
        checked = true;
        return false;
      },
      verifyProtectedAudit: async () => readyIntegrity,
    },
  );
  assert.equal(checked, false);
  assert.deepEqual(
    regulatedProductionOrganizationIds({ REGULATED_PRODUCTION_LAUNCH: "development" }),
    [],
  );
});

test("regulated startup guard blocks missing IDs, unknown tenants, and unready audit", async () => {
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true" },
      { organizationExists: async () => true, verifyProtectedAudit: async () => readyIntegrity },
    ),
    /ORGANIZATION_IDS is required/,
  );
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true", REGULATED_PRODUCTION_ORGANIZATION_IDS: "missing-org" },
      { organizationExists: async () => false, verifyProtectedAudit: async () => readyIntegrity },
    ),
    /does not exist/,
  );
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true", REGULATED_PRODUCTION_ORGANIZATION_IDS: "org-a" },
      {
        organizationExists: async () => true,
        verifyProtectedAudit: async () => ({
          ...readyIntegrity,
          externalAnchoring: {
            ...readyIntegrity.externalAnchoring,
            configured: false,
            regulatedProductionLaunchBlocked: true,
          },
        }),
      },
    ),
    /not fully ready/,
  );
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true", REGULATED_PRODUCTION_ORGANIZATION_IDS: "org-a" },
      {
        organizationExists: async () => true,
        verifyProtectedAudit: async () => ({
          ...readyIntegrity,
          externalAnchoring: {
            ...readyIntegrity.externalAnchoring,
            staleSnapshot: true,
          },
        }),
      },
    ),
    /not fully ready/,
  );
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true", REGULATED_PRODUCTION_ORGANIZATION_IDS: "org-a" },
      {
        organizationExists: async () => {
          throw new Error("database unavailable");
        },
        verifyProtectedAudit: async () => readyIntegrity,
      },
    ),
    /could not verify organization/,
  );
  await assert.rejects(
    () => enforceRegulatedProductionStartupGuard(
      { REGULATED_PRODUCTION_LAUNCH: "true", REGULATED_PRODUCTION_ORGANIZATION_IDS: "org-a" },
      {
        organizationExists: async () => true,
        verifyProtectedAudit: async () => {
          throw new Error("provider unavailable");
        },
      },
    ),
    /could not verify protected audit/,
  );
});

test("regulated startup guard allows every selected ready tenant", async () => {
  const checked: string[] = [];
  await enforceRegulatedProductionStartupGuard(
    {
      REGULATED_PRODUCTION_LAUNCH: "true",
      REGULATED_PRODUCTION_ORGANIZATION_IDS: "org-a, org-b",
    },
    {
      organizationExists: async (organizationId) => {
        checked.push(`exists:${organizationId}`);
        return true;
      },
      verifyProtectedAudit: async (organizationId) => {
        checked.push(`verify:${organizationId}`);
        return readyIntegrity;
      },
    },
  );
  assert.deepEqual(checked, ["exists:org-a", "verify:org-a", "exists:org-b", "verify:org-b"]);
});