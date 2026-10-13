import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, eq, or } from "drizzle-orm";
import {
  db,
  accessNamedGrants,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbFrontlineEvidence,
  onbFrontlineReleaseState,
  onbSystemChecks,
  onbSensitiveLifecyclePolicies,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  evaluateFrontlineFloorRelease,
  FrontlineValidationError,
  FrontlineRetainedError,
  getFrontlineKpiAggregate,
  getFrontlineEvidenceHistory,
  getFrontlineReadiness,
  getFrontlineAccess,
  recordFrontlineEvidence,
  recordFrontlineFulfillment,
  recordFrontlineKpiInput,
  revokeFrontlineEvidence,
  runFrontlineReleaseHeartbeat,
} from "./frontline-operations";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `frontline-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-tenant`;
const otherOrganizationId = `${suffix}-other`;
const users = {
  hr: `${suffix}-hr`, medical: `${suffix}-medical`, safety: `${suffix}-safety`,
  payroll: `${suffix}-payroll`, legal: `${suffix}-legal`, stores: `${suffix}-stores`, untrusted: `${suffix}-untrusted`,
};
const policy = {
  processPolicy: {
    frontline: {
      schemaVersion: "frontline-operations/v1",
      age: { minimumYears: 18 },
      fulfillment: { requiredItems: ["badge", "ppe", "uniform", "tool", "locker"] },
      statutory: { requirements: [{
        key: "US-payroll-registration", jurisdiction: "US",
        policyReference: "POL-FRONTLINE-TEST", reviewReference: "LEGAL-FRONTLINE-TEST",
      }, {
        key: "CA-site-registration", jurisdiction: "CA",
        policyReference: "POL-CA", reviewReference: "LEGAL-CA",
      }] },
      exceptions: { policyReference: "POL-FRONTLINE-TEST", reviewReference: "HSE-FRONTLINE-TEST", permitted: [] },
    },
  },
};

async function createCase(org = organizationId, requiredLicenses: string[] = [], processPolicySnapshot: Record<string, unknown> = policy, workState?: string) {
  const [created] = await db.insert(onbCases).values({
    organizationId: org, workerName: "Frontline fixture", workerEmail: `${randomUUID()}@example.test`,
    hireType: "employee", workerCategory: "employee", role: "Operator", department: "Operations",
    geography: "US", legalEntity: "Example US", managerName: "Manager", recruiterName: users.hr,
    createdByUserId: users.hr, joiningDate: "2032-01-01", lifecycleStage: "preboarding",
    orchestrationStatus: "waiting-approval",
    workforceContext: { workEnvironment: "site", safetyCritical: true, workCountry: "US", ...(workState ? { workState } : {}), requiredLicenses },
    processPolicySnapshot,
  }).returning();
  return created!;
}
async function addTrustedBgv(caseId: number) {
  await db.insert(onbSystemChecks).values({
    organizationId, caseId, system: "bgv", mode: "push", externalRef: `BGV-${caseId}`,
    status: "done", requestedAt: new Date(Date.now() - 60_000), dueAt: new Date(Date.now() + 60_000),
    completedAt: new Date(), evidenceProvenance: "trusted-provider",
  });
}
async function addEvidence(caseId: number, version: number, actorUserId: string, kind: string, extras: Record<string, unknown> = {}) {
  return recordFrontlineEvidence({
    organizationId, caseId, actorUserId, expectedVersion: version, kind: kind as never,
    evidenceReference: `${kind}-${randomUUID()}`, issuerTimestamp: new Date(Date.now() - 1_000).toISOString(),
    ...extras,
  });
}
async function completeReleasePrerequisites(caseId: number) {
  let version = 0;
  version = (await addEvidence(caseId, version, users.hr, "age-proof", { subjectAgeYears: 22 })).version;
  version = (await addEvidence(caseId, version, users.medical, "medical-fitness")).version;
  version = (await addEvidence(caseId, version, users.safety, "safety-competency")).version;
  version = (await addEvidence(caseId, version, users.payroll, "wage-setup")).version;
  version = (await addEvidence(caseId, version, users.payroll, "timesheet-setup")).version;
  version = (await addEvidence(caseId, version, users.legal, "statutory-registration", { statutoryKey: "US-payroll-registration" })).version;
  for (const fulfillmentItem of ["badge", "ppe", "uniform", "tool", "locker"] as const) {
    version = (await recordFrontlineFulfillment({
      organizationId, caseId, actorUserId: users.stores, expectedVersion: version, item: fulfillmentItem,
      assetReference: `asset-${fulfillmentItem}-${randomUUID()}`, ...(fulfillmentItem === "ppe" || fulfillmentItem === "uniform" ? { size: "M" } : {}),
      requestedQuantity: 1, issuedQuantity: 1, issuerTimestamp: new Date(Date.now() - 1_000).toISOString(),
      acknowledgedAt: new Date().toISOString(),
      acknowledgementRecipientReference: `worker-${caseId}`, acknowledgementMethod: "signed-receipt",
    })).version;
  }
  return version;
}

describe("frontline operations service (real DB)", { skip: !hasDb }, () => {
  before(async () => {
    for (const org of [organizationId, otherOrganizationId]) {
      await db.insert(organizationsTable).values({
        id: org, name: org, slug: org, joinCodeHash: `join-${org}`, createdByUserId: users.hr,
      });
      await seedApprovedSensitiveLifecyclePolicies(org);
      await db.insert(onbAuthorityGovernance).values({
        organizationId: org, status: "governance-approved", approvedByUserId: users.hr,
        approvedAt: new Date(), governanceSource: "test", revision: 1,
      });
    }
    const grants = [
      [users.hr, "hr-compliance", "hr-compliance-approve"],
      [users.medical, "occupational-health", "occupational-health-approve"],
      [users.safety, "safety", "safety-approve"],
      [users.payroll, "payroll", "payroll-approve"],
      [users.legal, "legal", "legal-approve"],
      [users.stores, "site-operations", "site-fulfillment-approve"],
    ] as const;
    for (const [userId, authorityRole, scope] of grants) {
      await db.insert(organizationMembershipsTable).values({ organizationId, clerkUserId: userId, role: "member" });
      await db.insert(onbAuthorityAssignments).values({
        id: `${suffix}-${authorityRole}`, organizationId, personUserId: userId, authorityRole,
        scopes: [scope], siteScope: "US", jurisdictionScope: "Example US",
        validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 60 * 60_000),
        status: "active", revision: 1, grantorUserId: "governance", source: "test", governanceDecisionRef: "GOV-TEST",
      });
      const privateKeys = authorityRole === "occupational-health" ? ["data.medical.read", "data.medical.edit"]
        : authorityRole === "payroll" ? ["data.payroll.read", "data.payroll.edit"]
        : authorityRole === "hr-compliance" ? ["data.identity.edit", "data.identity.read", "data.bgv.read", "data.medical.read", "data.payroll.read"]
        : authorityRole === "site-operations" ? []
        : ["data.medical.edit", "data.identity.edit", "data.bgv.edit"];
      for (const resourceKey of ["tool.approval.decide", "flow.case.edit", "flow.case.read", "data.case.notes.read", "data.case.notes.edit", "data.case.profile.read", ...privateKeys]) {
        await db.insert(accessNamedGrants).values({
          organizationId, principalType: "human", principalId: userId, resourceKey,
          resourceType: resourceKey.startsWith("tool.") ? "tool" : resourceKey.startsWith("flow.") ? "flow" : "field",
          scope: "tenant", source: "named", effect: "allow", status: "active", createdByUserId: "independent-test-owner",
          approvedByUserId: "independent-test-owner", approvedAt: new Date(),
        });
      }
    }
  });
  after(async () => {
    await db.delete(onbCases).where(or(eq(onbCases.organizationId, organizationId), eq(onbCases.organizationId, otherOrganizationId)));
    await db.delete(onbSensitiveLifecyclePolicies).where(or(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId), eq(onbSensitiveLifecyclePolicies.organizationId, otherOrganizationId)));
    await deleteTestOrganizations(or(eq(organizationsTable.id, organizationId), eq(organizationsTable.id, otherOrganizationId)));
  });

  test("requires a real age result, separate medical/safety authorities, wage and timesheet, dated statutory evidence, acknowledged assets, and then reblocks revoked authority", async () => {
    const c = await createCase();
    await addTrustedBgv(c.id);
    await assert.rejects(
      addEvidence(c.id, 0, users.hr, "age-proof", { subjectAgeYears: 17 }),
      /at least the explicit policy minimum/i,
    );
    await assert.rejects(
      addEvidence(c.id, 0, users.untrusted, "medical-fitness"),
      FrontlineValidationError,
    );
    const version = await completeReleasePrerequisites(c.id);
    const released = await evaluateFrontlineFloorRelease({ organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: version });
    assert.equal(released.release.eligible, true);
    const repeatedRelease = await evaluateFrontlineFloorRelease({ organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: released.version });
    assert.equal(repeatedRelease.version, released.version);
    assert.equal(repeatedRelease.release.recorded, true);
    const medicalHistory = await getFrontlineEvidenceHistory({ organizationId, caseId: c.id, actorUserId: users.medical });
    assert.deepEqual(medicalHistory.evidence.map((row) => row.kind), ["medical-fitness"]);
    assert.deepEqual(medicalHistory.exceptions, []);
    await assert.rejects(getFrontlineEvidenceHistory({ organizationId, caseId: c.id, actorUserId: users.stores }), /read permissions/);
    assert.equal(released.version, version + 1);

    // This is a current server-read authority revocation, not a client-provided
    // remote revocation claim. The next floor attempt must reopen/reblock.
    try {
      await db.update(accessNamedGrants).set({ status: "rejected" }).where(and(
        eq(accessNamedGrants.organizationId, organizationId), eq(accessNamedGrants.principalId, users.safety),
        eq(accessNamedGrants.resourceKey, "tool.approval.decide"),
      ));
      await runFrontlineReleaseHeartbeat();
      const reblocked = await getFrontlineReadiness(organizationId, c.id);
      assert.equal(reblocked.release.eligible, false);
      assert.equal(reblocked.release.reblocked, true);
      assert.match(reblocked.release.blockers.join(" "), /safety-competency/i);
    } finally {
      await db.update(accessNamedGrants).set({ status: "active" }).where(and(
        eq(accessNamedGrants.organizationId, organizationId), eq(accessNamedGrants.principalId, users.safety),
        eq(accessNamedGrants.resourceKey, "tool.approval.decide"),
      ));
    }
  });

  test("does not treat a stockout or missing acknowledgement as fulfilled, and broad readiness never exposes evidence references", async () => {
    const c = await createCase();
    const evidence = await addEvidence(c.id, 0, users.hr, "age-proof", { subjectAgeYears: 21 });
    await recordFrontlineFulfillment({
      organizationId, caseId: c.id, actorUserId: users.stores, expectedVersion: evidence.version, item: "ppe",
      assetReference: "private-ppe-asset-reference", size: "M", requestedQuantity: 2, issuedQuantity: 1,
      issuerTimestamp: new Date(Date.now() - 1_000).toISOString(),
    });
    const readiness = await getFrontlineReadiness(organizationId, c.id);
    assert.equal(readiness.release.eligible, false);
    assert.match(readiness.release.blockers.join(" "), /Physical ppe/i);
    assert.equal(JSON.stringify(readiness).includes("private-ppe-asset-reference"), false);
    const rows = await db.select().from(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, organizationId), eq(onbFrontlineEvidence.caseId, c.id)));
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(readiness).includes(rows[0]!.evidenceReference), false);
    assert.equal(JSON.stringify(readiness).includes("subjectAgeYears"), false);
  });

  test("requires both national and state statutory requirements when both jurisdictions apply", async () => {
    const c = await createCase(organizationId, [], policy, "CA");
    const readiness = await getFrontlineReadiness(organizationId, c.id);
    assert.equal(readiness.release.blockers.filter(message => message.includes("statutory-registration")).length, 2);
    assert.doesNotMatch(readiness.release.blockers.join(" "), /CA-site-registration|US-payroll-registration/);
    assert.equal(readiness.release.reblocked, false);
  });

  test("case viewing and fulfillment do not require every sensitive edit or private history permission", async () => {
    const c = await createCase();
    const access = await getFrontlineAccess({ organizationId, caseId: c.id, actorUserId: users.stores });
    assert.equal(access.fulfillmentEdit, true);
    assert.equal(access.historyRead, false);
    assert.equal(access.kpiRead, false);
    assert.equal(access.evidenceEdit["medical-fitness"], false);
    await assert.rejects(getFrontlineAccess({ organizationId, caseId: c.id, actorUserId: users.untrusted }), /case-read authority/);
    await assert.rejects(getFrontlineAccess({ organizationId: otherOrganizationId, caseId: c.id, actorUserId: users.stores }), /Case not found/);
  });

  test("retained records remain viewable but direct mutations and heartbeat cannot modify them", async () => {
    const c = await createCase();
    await db.update(onbCases).set({ controllerRetired: true }).where(eq(onbCases.id, c.id));
    const access = await getFrontlineAccess({ organizationId, caseId: c.id, actorUserId: users.hr });
    assert.equal(access.readOnly, true);
    assert.equal(access.historyRead, true);
    assert.equal(access.releaseEdit, false);
    assert.equal(Object.values(access.evidenceEdit).some(Boolean), false);
    await assert.rejects(recordFrontlineFulfillment({
      organizationId, caseId: c.id, actorUserId: users.stores, expectedVersion: 0,
      item: "badge", assetReference: "fixture-only", requestedQuantity: 1, issuedQuantity: 1,
      issuerTimestamp: new Date().toISOString(),
    }), error => error instanceof FrontlineRetainedError && error.statusCode === 410);
    await runFrontlineReleaseHeartbeat();
    assert.equal((await db.select().from(onbFrontlineReleaseState).where(eq(onbFrontlineReleaseState.caseId, c.id))).length, 0);
  });

  test("revoking only the medical field-edit grant reblocks already recorded floor release", async () => {
    const c = await createCase();
    await addTrustedBgv(c.id);
    const version = await completeReleasePrerequisites(c.id);
    const released = await evaluateFrontlineFloorRelease({ organizationId, caseId: c.id,
      actorUserId: users.hr, expectedVersion: version });
    assert.equal(released.release.eligible, true, JSON.stringify(released.release.blockers));
    const scopedGrant = and(eq(accessNamedGrants.organizationId, organizationId),
      eq(accessNamedGrants.principalId, users.medical), eq(accessNamedGrants.resourceKey, "data.medical.edit"));
    await db.update(accessNamedGrants).set({ status: "rejected" }).where(scopedGrant);
    try {
      const readiness = await getFrontlineReadiness(organizationId, c.id);
      assert.equal(readiness.release.eligible, false);
      assert.match(readiness.release.blockers.join(" "), /medical-fitness/);
      const retainedApproval = await db.select().from(accessNamedGrants).where(and(
        eq(accessNamedGrants.principalId, users.medical),
        eq(accessNamedGrants.resourceKey, "tool.approval.decide"),
      ));
      assert.equal(retainedApproval[0]?.status, "active");
      await runFrontlineReleaseHeartbeat();
      const [state] = await db.select().from(onbFrontlineReleaseState).where(eq(onbFrontlineReleaseState.caseId, c.id));
      assert.equal(state?.status, "blocked");
      assert.ok(state?.reblockedAt);
    } finally {
      await db.update(accessNamedGrants).set({ status: "active" }).where(scopedGrant);
    }
  });

  test("keeps expired evidence and each applicable skill as live floor blockers", async () => {
    const c = await createCase(organizationId, ["forklift-certificate"]);
    const age = await addEvidence(c.id, 0, users.hr, "age-proof", { subjectAgeYears: 21 });
    await addEvidence(c.id, age.version, users.medical, "medical-fitness", {
      issuerTimestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      effectiveAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const readiness = await getFrontlineReadiness(organizationId, c.id);
    assert.equal(readiness.release.eligible, false);
    assert.match(readiness.release.blockers.join(" "), /medical-fitness/i);
    assert.match(readiness.release.blockers.join(" "), /skill-certificate/i);
    assert.doesNotMatch(readiness.release.blockers.join(" "), /forklift-certificate/i);
  });

  test("records an evidence revocation only from a current scoped human authority and live release does not reuse it", async () => {
    const c = await createCase();
    await addTrustedBgv(c.id);
    await assert.rejects(addEvidence(c.id, 0, users.untrusted, "safety-competency", {
      status: "revoked", revocationReference: "untrusted-remote-claim",
    }), FrontlineValidationError);
    const version = await completeReleasePrerequisites(c.id);
    const released = await evaluateFrontlineFloorRelease({ organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: version });
    const [safetyEvidence] = await db.select().from(onbFrontlineEvidence).where(and(
      eq(onbFrontlineEvidence.organizationId, organizationId), eq(onbFrontlineEvidence.caseId, c.id),
      eq(onbFrontlineEvidence.kind, "safety-competency"),
    ));
    const revoked = await revokeFrontlineEvidence({
      organizationId, caseId: c.id, actorUserId: users.safety, expectedVersion: released.version,
      evidenceId: safetyEvidence!.id, revocationReference: "HUMAN-SAFETY-REVOCATION-1",
    });
    const result = await evaluateFrontlineFloorRelease({
      organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: revoked.version,
    });
    assert.equal(result.release.eligible, false);
    assert.equal(result.release.reblocked, true);
    assert.match(result.release.blockers.join(" "), /safety-competency/i);
  });

  test("reports actual dated cycle, turnaround, induction, issuance, and registration metrics without inventing an attrition result", async () => {
    const c = await createCase();
    await addTrustedBgv(c.id);
    const version = await completeReleasePrerequisites(c.id);
    const released = await evaluateFrontlineFloorRelease({ organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: version });
    const times = [
      ["intake", users.hr, 300_000],
      ["medical-result", users.medical, 240_000],
      ["safety-completed", users.safety, 180_000],
      ["ppe-issued", users.safety, 120_000],
      ["statutory-registered", users.legal, 60_000],
    ] as const;
    let expectedVersion = released.version;
    for (const [kind, actorUserId, ago] of times) {
      expectedVersion = (await recordFrontlineKpiInput({
        organizationId, caseId: c.id, actorUserId, expectedVersion, kind,
        occurredAt: new Date(Date.now() - ago).toISOString(), evidenceReference: `kpi-${kind}-${randomUUID()}`,
      })).version;
    }
    const aggregate = await getFrontlineKpiAggregate({ organizationId, caseId: c.id, actorUserId: users.hr });
    assert.equal(typeof aggregate.metrics.floorReadyCycleSeconds, "number");
    assert.ok((aggregate.metrics.medicalTurnaroundSeconds ?? 0) >= 59);
    assert.equal(aggregate.metrics.safetyInductionCompleted, true);
    assert.equal(aggregate.metrics.ppeIssuanceCompliant, true);
    assert.equal(aggregate.metrics.statutoryRegistrationRecorded, true);
    assert.equal(aggregate.metrics.attrition0To30Days.state, "pending-review");
    await assert.rejects(getFrontlineKpiAggregate({ organizationId, caseId: c.id, actorUserId: users.untrusted }), /read permissions/i);
  });

  test("does not cross tenant case data", async () => {
    const c = await createCase();
    await assert.rejects(getFrontlineReadiness(otherOrganizationId, c.id), /Case not found/i);
    await assert.rejects(recordFrontlineEvidence({
      organizationId: otherOrganizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: 0,
      kind: "age-proof", evidenceReference: "cross-tenant-batch-claim",
      issuerTimestamp: new Date().toISOString(), subjectAgeYears: 21,
    }), /Case not found/i);
  });

  test("rejects an actual-exit KPI input without an authoritative dated actual joining anchor", async () => {
    const c = await createCase();
    await assert.rejects(recordFrontlineKpiInput({
      organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: 0,
      kind: "intake", occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      evidenceReference: "future-kpi",
    }), /cannot be in the future/i);
    const exitAt = new Date(Date.now() - 1_000).toISOString();
    await assert.rejects(recordFrontlineKpiInput({
      organizationId, caseId: c.id, actorUserId: users.hr, expectedVersion: 0,
      kind: "actual-exit", occurredAt: exitAt,
      actualExitAt: exitAt, evidenceReference: "exit-without-actual-join",
    }), /authoritative actual joining/i);
  });
});