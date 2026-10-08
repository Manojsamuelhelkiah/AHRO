import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { db } from "@workspace/db";
import {
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  organizationMembershipsTable,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEffectJournal,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisions,
  onbGovernanceDecisionReviews,
  onbGovernanceDispatchMarkers,
  onbGovernanceRequirements,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
  onbReadinessSlaPolicies,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  onbSystemChecks,
  organizationsTable,
} from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  BANK_CHANGE_APPROVAL_RULE,
  PRIVILEGED_ACCESS_APPROVAL_RULE,
  hashApprovalProposal,
  type ApprovalDecision,
} from "./compound-action-contract";
import type { ConnectorMutation } from "./connector-adapters";
import {
  dispatchCaseConnectorMutation,
  dispatchWorkstreamConnectorMutations,
  workstreamPolicyGateOpen,
  type WorkstreamConnectorCase,
} from "./workstream-connectors";
import { recoverUntrackedCaseSystems } from "./system-watcher";
import { EXECUTION_AUTHORIZATION_RULES } from "./decision-authority";
import {
  adoptGovernanceDecisionSnapshot,
  governanceSnapshotForNewCase,
  withGovernanceDecisionSnapshot,
} from "./governance-runtime";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import {
  changeStandardOperationsStartDate,
  setStandardOperationsException,
} from "./standard-operations";
import { resumeChecklistOrchestration, runWorkstreams } from "./engine";
import { ensureReadinessSlaEnrollment } from "./readiness-sla-policy";

const createdCaseIds: number[] = [];
const unitOrganizationId = `workstream-guard-${process.pid}-${randomUUID()}`;
let unitCaseId: number;
let unitPolicySnapshot: Record<string, unknown>;

async function establishLiveGovernanceFixture(
  caseId: number,
  options: { sourceEvidence?: boolean } = {},
) {
  await governanceSnapshotForNewCase(unitOrganizationId);
  const decisions = await db.select().from(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, unitOrganizationId));
  for (const decision of decisions) {
    const reviewer = `fixture:${decision.accountableRole}`;
    const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId: unitOrganizationId, authorityRole: decision.accountableRole, assigneeUserId: reviewer,
      verificationStatus: "verified", verifiedByUserId: "fixture-operator", verificationReference: reviewer,
    }).returning({ id: onbGovernanceAuthorityAssignments.id });
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId: unitOrganizationId, decisionKey: decision.key, decisionRevision: decision.revision,
      outcome: "approved", reason: "Fixture approved decision", authorityAssignmentId: authority!.id,
      reviewedByUserId: reviewer, verificationReference: reviewer,
    }).onConflictDoNothing();
    await db.update(onbGovernanceDecisions).set({
      status: "approved", approvedByUserId: reviewer, approvedAt: new Date(),
    }).where(and(
      eq(onbGovernanceDecisions.organizationId, unitOrganizationId),
      eq(onbGovernanceDecisions.key, decision.key),
      eq(onbGovernanceDecisions.revision, decision.revision),
    ));
  }
  await db.update(onbGovernanceRequirements).set({
    implemented: true, tested: true, configured: true, approvedForLive: true,
  }).where(eq(onbGovernanceRequirements.organizationId, unitOrganizationId));
  for (const key of ["bgv", "itsm", "payroll"]) {
    await db.insert(onbConnectors).values({
      organizationId: unitOrganizationId, key, label: key, vendor: "fixture-live",
      availableVendors: ["fixture-live"], status: "connected", trackingMode: "api",
      description: "Fixture synchronized live provider", authoritativeFor: [key], lastSyncAt: new Date(),
      configurationProvenance: "trusted-provider",
    }).onConflictDoUpdate({
      target: [onbConnectors.organizationId, onbConnectors.key],
      set: { status: "connected", lastSyncAt: new Date(), configurationProvenance: "trusted-provider" },
    });
  }
  unitPolicySnapshot = withGovernanceDecisionSnapshot({}, await governanceSnapshotForNewCase(unitOrganizationId));
  await db.update(onbCases).set({ processPolicySnapshot: unitPolicySnapshot }).where(eq(onbCases.id, caseId));
  if (options.sourceEvidence !== false) {
    await db.insert(onbSystemChecks).values({
      organizationId: unitOrganizationId, caseId, system: "bgv", mode: "push", externalRef: `fixture-bgv-${caseId}`,
      status: "done", dueAt: new Date(), completedAt: new Date(), lastCheckedAt: new Date(),
      evidenceProvenance: "trusted-provider",
    });
  }
  if (options.sourceEvidence !== false) {
    const [caseRow] = await db.select({ joiningDate: onbCases.joiningDate }).from(onbCases).where(and(
      eq(onbCases.organizationId, unitOrganizationId),
      eq(onbCases.id, caseId),
    ));
    assert.ok(caseRow);
    await db.insert(onbReadinessSlaCaseState).values({
      organizationId: unitOrganizationId, caseId, snapshotVersion: 1,
      payrollCutoff: new Date("2030-01-01T00:00:00Z"),
    });
    await db.insert(onbReadinessSlaAttestations).values({
      organizationId: unitOrganizationId, caseId, snapshotVersion: 1, streamKey: "hris", complete: true,
      reason: "Fixture HRIS source attestation", attestedBy: "fixture", attestedRole: "hr-operations",
      evidenceProvenance: "trusted-provider",
      sourceStartDate: caseRow.joiningDate,
      sourceEvidenceRevision: `fixture-oracle-${caseId}`,
    });
  }
}

before(async () => {
  await db.insert(organizationsTable).values({
    id: unitOrganizationId,
    name: "Workstream connector guard test",
    slug: unitOrganizationId,
    joinCodeHash: `hash-${unitOrganizationId}`,
    createdByUserId: "workstream-connector-test",
  });
  await seedApprovedSensitiveLifecyclePolicies(unitOrganizationId);
});

beforeEach(async () => {
  await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, unitOrganizationId));
  // Standard-operations state is intentionally case-scoped in production.
  // Clear fixture state between tests so a deterministic race fixture cannot
  // contaminate a later simulated connector path.
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, unitOrganizationId));
  // Each authorization scenario needs a fresh operation identity. Confirmed
  // effects from an earlier test must not turn this into a replay-only test.
  const [created] = await db.insert(onbCases).values({
    organizationId: unitOrganizationId,
    workerName: "Connector unit fixture",
    workerEmail: "connector-unit@example.invalid",
    workerCategory: "employee",
    hireType: "external-fte",
    role: "Engineer",
    department: "Technology",
    geography: "United Kingdom",
    legalEntity: "Example Ltd",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "US" },
    lifecycleStage: "plan-generated",
    orchestrationStatus: "running",
    offerAcceptanceComplete: true,
    readiness: [],
    workstreams: [],
  }).returning({ id: onbCases.id });
  unitCaseId = created.id;
  await establishLiveGovernanceFixture(unitCaseId);
});

after(async () => {
  await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, unitOrganizationId));
  await db.delete(onbSettings).where(eq(onbSettings.organizationId, unitOrganizationId));
  await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, unitOrganizationId));
  await db.delete(onbCases).where(eq(onbCases.organizationId, unitOrganizationId));
  await db.delete(onbGovernanceDecisionReviews).where(eq(onbGovernanceDecisionReviews.organizationId, unitOrganizationId));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, unitOrganizationId));
  await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, unitOrganizationId));
  await db.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, unitOrganizationId));
  await db.delete(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, unitOrganizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, unitOrganizationId));
  await db.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, unitOrganizationId));
  await deleteTestOrganizations(eq(organizationsTable.id, unitOrganizationId));
  for (const id of createdCaseIds) {
    await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, id));
    await db.delete(onbCases).where(eq(onbCases.id, id));
  }
});

async function createDatabaseCase(lifecycleStage: string) {
  const [created] = await db
    .insert(onbCases)
    .values({
      organizationId: unitOrganizationId,
      workerName: `Connector Gate ${Date.now()}`,
      workerEmail: `connector-gate-${Date.now()}@example.test`,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Engineer",
      department: "Technology",
      geography: "United Kingdom",
      legalEntity: "Example Ltd",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2026-10-01",
      workforceContext: { workCountry: "US" },
      lifecycleStage,
      orchestrationStatus: "running",
      offerAcceptanceComplete: true,
      createdByUserId: "database-case-requestor",
      readiness: [],
      workstreams: [],
      processPolicySnapshot: unitPolicySnapshot,
    })
    .returning();
  createdCaseIds.push(created.id);
  const authorityId = `workstream-hr-${created.id}`;
  await db.insert(onbAuthorityGovernance).values({
    organizationId: unitOrganizationId,
    status: "governance-approved",
    approvedByUserId: "governance-test",
    approvedAt: new Date(),
    governanceSource: "test",
    revision: 1,
  }).onConflictDoUpdate({
    target: onbAuthorityGovernance.organizationId,
    set: { status: "governance-approved", revision: 1, updatedAt: new Date() },
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: unitOrganizationId,
    clerkUserId: "workstream-hr-reviewer",
    role: "member",
  }).onConflictDoNothing();
  await db.insert(onbAuthorityAssignments).values({
    id: authorityId,
    organizationId: unitOrganizationId,
    personUserId: "workstream-hr-reviewer",
    authorityRole: "hr-compliance",
    scopes: ["hr-compliance-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "governance-test",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  await db.insert(onbApprovals).values({
    organizationId: unitOrganizationId,
    caseId: created.id,
    agent: "offer-acceptance-gate",
    ruleRef: "Gate A — offer-acceptance package",
    hitlPattern: "hard-block",
    recommendation: "Reviewed",
    rationale: "Fixture",
    resumeAction: "none",
    status: "approved",
    authorityScope: "hr-compliance-approve",
    decidedAuthorityId: authorityId,
    decidedAuthorityRevision: 1,
    idempotencyKey: `gate-a-fixture-${created.id}`,
  });
  const operationAuthorities = [
    ["documents", "legal", "legal-approve"],
    ["background-verification", "hr-compliance", "hr-compliance-approve"],
    ["iam", "it-security", "it-security-approve"],
    ["payroll", "payroll", "payroll-approve"],
  ] as const;
  for (const [connector, authorityRole, authorityScope] of operationAuthorities) {
    const reviewer = `workstream-${connector}-reviewer`;
    const operationAuthorityId = `workstream-${connector}-${created.id}`;
    await db.insert(organizationMembershipsTable).values({
      organizationId: unitOrganizationId, clerkUserId: reviewer, role: "member",
    }).onConflictDoNothing();
    await db.insert(onbAuthorityAssignments).values({
      id: operationAuthorityId, organizationId: unitOrganizationId,
      personUserId: reviewer, authorityRole, scopes: [authorityScope],
      validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 60_000),
      status: "active", revision: 1, grantorUserId: "governance-test",
      source: "test", governanceDecisionRef: "GOV-TEST",
    });
    await db.insert(onbApprovals).values({
      organizationId: unitOrganizationId, caseId: created.id, agent: "workstreams",
      ruleRef: EXECUTION_AUTHORIZATION_RULES[connector], hitlPattern: "approve-before-act",
      recommendation: "Fixture", rationale: "Fixture", resumeAction: "continue-after-plan",
      status: "approved", authorityScope, decidedAuthorityId: operationAuthorityId,
      decidedAuthorityRevision: 1, idempotencyKey: `execution-${connector}-${created.id}`,
    });
  }
  return created;
}

async function createApprovedInternalTransferCase() {
  const [created] = await db.insert(onbCases).values({
    organizationId: unitOrganizationId,
    workerName: "Internal transfer execution fixture",
    workerEmail: `internal-transfer-${randomUUID()}@example.test`,
    workerCategory: "employee",
    hireType: "internal-transfer",
    role: "Engineer",
    department: "Technology",
    geography: "United Kingdom",
    legalEntity: "Example Ltd",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "US" },
    lifecycleStage: "plan-generated",
    orchestrationStatus: "running",
    offerAcceptanceComplete: false,
    createdByUserId: "internal-transfer-requestor",
    readiness: [],
    workstreams: [],
  }).returning();
  createdCaseIds.push(created.id);
  const authorityId = `workstream-legal-${created.id}`;
  await db.insert(onbAuthorityGovernance).values({
    organizationId: unitOrganizationId,
    status: "governance-approved",
    approvedByUserId: "governance-test",
    approvedAt: new Date(),
    governanceSource: "test",
    revision: 1,
  }).onConflictDoUpdate({
    target: onbAuthorityGovernance.organizationId,
    set: { status: "governance-approved", revision: 1, updatedAt: new Date() },
  });
  await db.insert(organizationMembershipsTable).values({
    organizationId: unitOrganizationId,
    clerkUserId: "workstream-legal-reviewer",
    role: "member",
  }).onConflictDoNothing();
  await db.insert(onbAuthorityAssignments).values({
    id: authorityId,
    organizationId: unitOrganizationId,
    personUserId: "workstream-legal-reviewer",
    authorityRole: "legal",
    scopes: ["legal-approve"],
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 60_000),
    status: "active",
    revision: 1,
    grantorUserId: "governance-test",
    source: "test",
    governanceDecisionRef: "GOV-TEST",
  });
  await db.insert(onbApprovals).values({
    organizationId: unitOrganizationId,
    caseId: created.id,
    agent: "intake",
    ruleRef: "4.1 Intake Rule 4",
    hitlPattern: "approve-before-act",
    recommendation: "Preserve existing employee identity",
    rationale: "Fixture",
    resumeAction: "continue-after-intake",
    status: "approved",
    authorityScope: "legal-approve",
    decidedAuthorityId: authorityId,
    decidedAuthorityRevision: 1,
    idempotencyKey: `internal-transfer-fixture-${created.id}`,
  });
  return created;
}

function caseRow(
  patch: Partial<WorkstreamConnectorCase> = {},
): WorkstreamConnectorCase {
  return {
    id: unitCaseId,
    organizationId: unitOrganizationId,
    workerEmail: "worker@example.com",
    workerCategory: "employee",
    hireType: "external-fte",
    geography: "United Kingdom",
    legalEntity: "Example Ltd",
    lifecycleStage: "plan-generated",
    recruiterName: "Recruiter",
    createdByUserId: null,
    updatedAt: new Date("2026-09-08T00:00:00Z"),
    workstreams: [],
    processPolicySnapshot: unitPolicySnapshot,
    ...patch,
  };
}

describe("workstream connector runtime enforcement", () => {
  test("a prospectively snapshotted case cannot reach a live writer while its tenant requirement lacks live approval", async () => {
    let writes = 0;
    await db.update(onbGovernanceRequirements).set({ approvedForLive: false }).where(and(
      eq(onbGovernanceRequirements.organizationId, unitOrganizationId),
      eq(onbGovernanceRequirements.key, "REQ-02"),
    ));
    const governanceSnapshot = adoptGovernanceDecisionSnapshot({
      decisions: [],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    await assert.rejects(
      dispatchCaseConnectorMutation({
        c: caseRow({
          processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
        }),
        mutation: {
          connector: "documents",
          operation: "send-envelope",
          payload: {
            caseId: unitCaseId,
            workerCategory: "employee",
            geography: "United Kingdom",
            hireType: "external-fte",
          },
        },
        dependencies: {
          write: async () => {
            writes += 1;
          },
        },
      }),
      /governance:.*requirement-not-approved-for-live/,
    );
    assert.equal(writes, 0);
  });

  test("an unmet snapshotted before-workstreams evidence gate blocks every dispatch path", () => {
    assert.equal(workstreamPolicyGateOpen(caseRow({
      orchestrationStatus: "checklist-blocked",
      checklistSnapshot: [{
        id: "safety-sign-off", label: "Safety", order: 0, enabled: true, mandatory: true,
        enforcementStage: "before-workstreams", evidenceRequired: true,
      }],
      readiness: [{ key: "safety-sign-off", label: "Safety", status: "pending" }],
    })), false);
  });
  test("the default writers seed documents and BGV but do not release access before trusted clearance", async () => {
    const c = await createDatabaseCase("plan-generated");
    const outcome = await dispatchWorkstreamConnectorMutations(c);
    assert.deepEqual(outcome, { releaseHeld: true, heldConnectors: ["iam", "payroll"] });

    const documents = await db
      .select()
      .from(onbDocuments)
      .where(eq(onbDocuments.caseId, c.id));
    const checks = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.caseId, c.id));

    assert.ok(documents.length > 0);
    assert.ok(documents.every((document) => document.caseId === c.id));
    assert.deepEqual(
      checks.map((check) => check.system).sort(),
      ["bgv"],
    );
  });

  test("untracked recovery parks a held release and resumes it after trusted source evidence", async () => {
    const c = await createDatabaseCase("preboarding");
    // Pre-create the exact engine execution approval identities so the source
    // refresh can resume the stored checkpoint without manufacturing a second
    // approval cycle. The authoritative fixture approvals remain unchanged.
    await db.update(onbCases).set({ workerCategory: "contractor" }).where(eq(onbCases.id, c.id));
    for (const connector of ["documents", "background-verification", "iam", "payroll"]) {
      await db.update(onbApprovals).set({
        idempotencyKey: `orchestration:${c.id}:approval:execution:${connector}`,
      }).where(and(
        eq(onbApprovals.caseId, c.id),
        eq(onbApprovals.idempotencyKey, `execution-${connector}-${c.id}`),
      ));
    }
    await establishLiveGovernanceFixture(c.id, { sourceEvidence: false });
    await recoverUntrackedCaseSystems(c.id);

    const documents = await db
      .select()
      .from(onbDocuments)
      .where(eq(onbDocuments.caseId, c.id));
    const checks = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.caseId, c.id));

    assert.ok(documents.length > 0);
    assert.deepEqual(
      checks.map((check) => check.system).sort(),
      ["bgv"],
    );
    let [held] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    assert.equal(held.orchestrationStatus, "checklist-blocked");
    assert.equal(held.orchestrationCheckpoint, "waiting:standard-operations-release");
    assert.equal(held.orchestrationClaimOwner, null);
    assert.equal(held.orchestrationClaimUntil, null);

    await db.update(onbSystemChecks).set({
      status: "done",
      completedAt: new Date(),
      lastCheckedAt: new Date(),
      evidenceProvenance: "trusted-provider",
    }).where(and(eq(onbSystemChecks.caseId, c.id), eq(onbSystemChecks.system, "bgv")));
    // Oracle classifier records trusted HRIS evidence only for an enrolled
    // SLA cohort; model that durable current snapshot before its refresh.
    const enrollment = await ensureReadinessSlaEnrollment(
      unitOrganizationId, c.id, "workstream-connectors-test",
    );
    assert.ok(enrollment);
    await db.insert(onbReadinessSlaAttestations).values({
      organizationId: unitOrganizationId,
      caseId: c.id,
      snapshotVersion: enrollment.state.snapshotVersion,
      streamKey: "hris",
      complete: true,
      reason: "Trusted HRIS refresh after recovery",
      attestedBy: "fixture",
      attestedRole: "hr-operations",
      evidenceProvenance: "trusted-provider",
      sourceStartDate: c.joiningDate,
      sourceEvidenceRevision: `fixture-oracle-refresh-${c.id}`,
    });
    assert.equal(await resumeChecklistOrchestration(c.id), true);
    [held] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    assert.notEqual(held.orchestrationStatus, "blocked");
    assert.notEqual(held.orchestrationCheckpoint, "waiting:standard-operations-release");
    const resumedChecks = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, c.id));
    assert.ok(resumedChecks.some((check) => check.system === "itsm"));
  });

  test("a legal continuation alone cannot authorize internal-transfer provider effects", async () => {
    const c = await createApprovedInternalTransferCase();
    await establishLiveGovernanceFixture(c.id);
    c.processPolicySnapshot = unitPolicySnapshot;
    await assert.rejects(
      dispatchWorkstreamConnectorMutations(c),
      /execution_authority_evidence_required/,
    );
  });

  test("rechecks an HR Operations hold immediately before the IAM writer", async () => {
    const c = await createDatabaseCase("preboarding");
    await establishLiveGovernanceFixture(c.id);
    let writes = 0;
    await assert.rejects(
      dispatchCaseConnectorMutation({
        c,
        mutation: {
          connector: "iam",
          operation: "provision-account",
          payload: { caseId: c.id },
        },
        dependencies: {
          authorize: (proposal) => ({
            binding: { proposalHash: hashApprovalProposal(proposal) },
            decisions: [],
          }),
          verifyCurrentAuthority: async () => ({ allowed: true }),
          // The hold is introduced after the preliminary release check but
          // before the guarded writer callback. This models the otherwise
          // timing-dependent policy-mutation race deterministically.
          withAuthorityFence: async (performWrite) => {
            await setStandardOperationsException({
              organizationId: c.organizationId,
              caseId: c.id,
              type: "no-response",
              expectedVersion: 0,
              actorUserId: "workstream-hr-reviewer",
            });
            return performWrite();
          },
          write: async () => {
            writes += 1;
          },
        },
      }),
      /standard-operations:.*no-response/,
    );
    assert.equal(writes, 0);
  });

  test("blocks payroll at both release checks until its changed-date stream is reconciled", async () => {
    const payrollMutation = (caseId: number): ConnectorMutation => ({
      connector: "payroll",
      operation: "enrol-worker",
      payload: {
        caseId,
        workerCategory: "employee",
        geography: "United Kingdom",
        hireType: "external-fte",
      },
    });
    const baseDependencies = {
      authorize: (proposal: Parameters<typeof hashApprovalProposal>[0]) => ({
        binding: { proposalHash: hashApprovalProposal(proposal) },
        decisions: [],
      }),
      verifyCurrentAuthority: async () => ({ allowed: true as const }),
    };

    const prechecked = await createDatabaseCase("plan-generated");
    await establishLiveGovernanceFixture(prechecked.id);
    await changeStandardOperationsStartDate({
      organizationId: prechecked.organizationId,
      caseId: prechecked.id,
      startDate: "2026-11-01",
      expectedVersion: 0,
      actorUserId: "workstream-hr-reviewer",
    });
    let writes = 0;
    await assert.rejects(
      dispatchCaseConnectorMutation({
        c: prechecked,
        mutation: payrollMutation(prechecked.id),
        dependencies: {
          ...baseDependencies,
          write: async () => { writes += 1; },
        },
      }),
      /standard-operations:.*Payroll start-date impact remains review-required/,
    );
    assert.equal(writes, 0);

    const fenced = await createDatabaseCase("plan-generated");
    await establishLiveGovernanceFixture(fenced.id);
    writes = 0;
    await assert.rejects(
      dispatchCaseConnectorMutation({
        c: fenced,
        mutation: payrollMutation(fenced.id),
        dependencies: {
          ...baseDependencies,
          withAuthorityFence: async (performWrite) => {
            await changeStandardOperationsStartDate({
              organizationId: fenced.organizationId,
              caseId: fenced.id,
              startDate: "2026-11-01",
              expectedVersion: 0,
              actorUserId: "workstream-hr-reviewer",
            });
            return performWrite();
          },
          write: async () => { writes += 1; },
        },
      }),
      /standard-operations:.*Payroll start-date impact remains review-required/,
    );
    assert.equal(writes, 0);
  });

  test("engine persists a Standard Operations release checkpoint and resumes it after trusted sources", async () => {
    const c = await createDatabaseCase("plan-generated");
    // Keep the focused engine fixture out of payroll: this test exercises the
    // access release path and avoids manufacturing an SLA enrollment solely
    // to supply an unrelated payroll cutoff.
    await db.update(onbCases).set({ workerCategory: "contractor" }).where(eq(onbCases.id, c.id));
    await establishLiveGovernanceFixture(c.id, { sourceEvidence: false });

    // First pass creates the durable specialist approval requests. Approve
    // them using the already-current authoritative assignments in this safe
    // DB fixture, then re-enter the real engine workstream stage.
    assert.equal(await runWorkstreams(c.id), "paused", "engine should pause for specialist approvals");
    const approvals = await db.select().from(onbApprovals).where(eq(onbApprovals.caseId, c.id));
    const executionByRule = new Map(approvals
      .filter((approval) => approval.idempotencyKey?.startsWith(`execution-`))
      .map((approval) => [approval.ruleRef, approval]));
    for (const approval of approvals.filter((item) =>
      item.idempotencyKey?.startsWith(`orchestration:${c.id}:approval:execution:`))) {
      const approved = executionByRule.get(approval.ruleRef);
      assert.ok(approved?.decidedAuthorityId);
      await db.update(onbApprovals).set({
        status: "approved",
        decidedAuthorityId: approved!.decidedAuthorityId,
        decidedAuthorityRevision: approved!.decidedAuthorityRevision,
      }).where(eq(onbApprovals.id, approval.id));
    }
    // The fixture's bootstrap approvals supplied the authority identity above.
    // Keep only the engine-created approval cycle before executing so duplicate
    // same-authority decisions cannot be mistaken for a SoD conflict.
    await db.delete(onbApprovals).where(and(
      eq(onbApprovals.caseId, c.id),
      sql`${onbApprovals.idempotencyKey} like ${"execution-%"}`,
    ));

    assert.equal(await runWorkstreams(c.id), "paused", "held IAM release must park at the durable checkpoint");
    let [held] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    assert.equal(held.orchestrationStatus, "checklist-blocked");
    assert.equal(held.orchestrationCheckpoint, "waiting:standard-operations-release");
    const initialChecks = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, c.id));
    assert.ok(initialChecks.some((check) => check.system === "bgv"), JSON.stringify(initialChecks));
    assert.ok(!initialChecks.some((check) => check.system === "itsm"), JSON.stringify(initialChecks));

    await db.update(onbSystemChecks).set({
      status: "done",
      completedAt: new Date(),
      lastCheckedAt: new Date(),
      evidenceProvenance: "trusted-provider",
    }).where(and(eq(onbSystemChecks.caseId, c.id), eq(onbSystemChecks.system, "bgv")));
    const enrollment = await ensureReadinessSlaEnrollment(
      unitOrganizationId, c.id, "workstream-connectors-test",
    );
    assert.ok(enrollment);
    await db.insert(onbReadinessSlaAttestations).values({
      organizationId: unitOrganizationId, caseId: c.id, snapshotVersion: enrollment.state.snapshotVersion,
      streamKey: "hris", complete: true, reason: "Trusted HRIS refresh",
      attestedBy: "fixture", attestedRole: "hr-operations",
      evidenceProvenance: "trusted-provider",
      sourceStartDate: c.joiningDate,
      sourceEvidenceRevision: `fixture-oracle-refresh-${c.id}`,
    });

    assert.equal(await resumeChecklistOrchestration(c.id), true, "trusted source refresh should claim the stored release checkpoint");
    [held] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    assert.notEqual(held.orchestrationStatus, "blocked");
    assert.notEqual(held.orchestrationCheckpoint, "waiting:standard-operations-release");
    const resumedChecks = await db.select().from(onbSystemChecks).where(eq(onbSystemChecks.caseId, c.id));
    assert.ok(resumedChecks.some((check) => check.system === "itsm"));
  });

  test("the real simulated workflow routes documents, BGV, IAM, and payroll through the gate", async () => {
    const c = await createDatabaseCase("plan-generated");
    await establishLiveGovernanceFixture(c.id);
    const writes: ConnectorMutation[] = [];
    await dispatchWorkstreamConnectorMutations(c, {
      authorize: (proposal) => ({
        binding: { proposalHash: hashApprovalProposal(proposal) },
        decisions: [],
      }),
      write: async (mutation) => {
        writes.push(mutation as ConnectorMutation);
      },
      now: () => new Date("2026-09-08T01:00:00Z"),
      verifyCurrentAuthority: async () => ({ allowed: true }),
      withAuthorityFence: async (write) => write(),
    });
    assert.deepEqual(
      writes.map(({ connector, operation }) => `${connector}:${operation}`),
      [
        "documents:send-envelope",
        "background-verification:open-check",
        "iam:provision-account",
        "payroll:enrol-worker",
      ],
    );
  });

  test("a mismatched persisted binding prevents the workflow writer", async () => {
    let writes = 0;
    await assert.rejects(
      dispatchWorkstreamConnectorMutations(caseRow(), {
        authorize: () => ({
          binding: { proposalHash: "stale-plan-binding" },
          decisions: [],
        }),
        write: async () => {
          writes += 1;
        },
      }),
      /unbound_proposal/,
    );
    assert.equal(writes, 0);
  });

  test("expired or rejected stored decisions prevent the workflow writer", async () => {
    for (const state of ["expired", "rejected"] as const) {
      let writes = 0;
      await assert.rejects(
        dispatchWorkstreamConnectorMutations(caseRow(), {
          authorize: (proposal) => ({
            binding: { proposalHash: hashApprovalProposal(proposal) },
            decisions: [
              {
                proposalHash: hashApprovalProposal(proposal),
                authorityId: "reviewer-1",
                authorityRole: "reviewer",
                decision: state === "rejected" ? "rejected" : "approved",
                expiresAt:
                  state === "expired"
                    ? new Date("2026-09-07T00:00:00Z")
                    : new Date("2026-09-09T00:00:00Z"),
              },
            ],
          }),
          write: async () => {
            writes += 1;
          },
          now: () => new Date("2026-09-08T00:00:00Z"),
        }),
        state === "expired" ? /expired_approval/ : /rejected/,
      );
      assert.equal(writes, 0);
    }
  });

  test("under-approved bank and privileged mutations cannot reach workflow writers", async () => {
    const sensitive: Array<{
      mutation: ConnectorMutation;
      role: string;
      authorityId: string;
    }> = [
      {
        mutation: {
          connector: "payroll",
          operation: "bank-change",
          payload: { accountToken: "vault-ref" },
        },
        role: BANK_CHANGE_APPROVAL_RULE.allOf[0],
        authorityId: "fraud-1",
      },
      {
        mutation: {
          connector: "iam",
          operation: "privileged-access",
          payload: { role: "administrator" },
        },
        role: PRIVILEGED_ACCESS_APPROVAL_RULE.allOf[0],
        authorityId: "manager-1",
      },
    ];
    for (const { mutation, role, authorityId } of sensitive) {
      let writes = 0;
      await assert.rejects(
        dispatchCaseConnectorMutation({
          c: caseRow(),
          mutation,
          dependencies: {
            authorize: (proposal) => ({
              binding: { proposalHash: hashApprovalProposal(proposal) },
              decisions: [
                {
                  proposalHash: hashApprovalProposal(proposal),
                  authorityId,
                  authorityRole: role,
                  decision: "approved",
                  expiresAt: new Date("2026-09-09T00:00:00Z"),
                } satisfies ApprovalDecision,
              ],
            }),
            write: async () => {
              writes += 1;
            },
            now: () => new Date("2026-09-08T00:00:00Z"),
          },
        }),
        /missing_authority/,
      );
      assert.equal(writes, 0);
    }
  });

  test("a fully approved sensitive mutation reaches the exact workflow writer", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const writes: ConnectorMutation[] = [];
    await dispatchCaseConnectorMutation({
      c: caseRow(),
      mutation,
      dependencies: {
        authorize: (proposal) => ({
          binding: { proposalHash: hashApprovalProposal(proposal) },
          decisions: BANK_CHANGE_APPROVAL_RULE.allOf.map(
            (authorityRole, index) => ({
              proposalHash: hashApprovalProposal(proposal),
              authorityId: `authority-${index}`,
              authorityRole,
              decision: "approved",
              expiresAt: new Date("2026-09-09T00:00:00Z"),
            }),
          ),
        }),
        write: async (boundMutation) => {
          writes.push(boundMutation as ConnectorMutation);
        },
        verifyCurrentAuthority: async () => ({ allowed: true }),
        withAuthorityFence: async (write) => write(),
        now: () => new Date("2026-09-08T00:00:00Z"),
      },
    });
    assert.deepEqual(writes, [mutation]);
  });

  test("non-employee applicability omits payroll but still dispatches documents", async () => {
    const seeded = await createDatabaseCase("plan-generated");
    await db.update(onbCases).set({
      workerName: "Contractor fixture",
      workerCategory: "contractor",
      hireType: "contractor",
    }).where(eq(onbCases.id, seeded.id));
    const [contractor] = await db.select().from(onbCases).where(eq(onbCases.id, seeded.id));
    assert.ok(contractor);
    await establishLiveGovernanceFixture(contractor.id);
    const writes: ConnectorMutation[] = [];
    await dispatchWorkstreamConnectorMutations(
      contractor,
      {
        authorize: (proposal) => ({
          binding: { proposalHash: hashApprovalProposal(proposal) },
          decisions: [],
        }),
        write: async (mutation) => {
          writes.push(mutation as ConnectorMutation);
        },
        verifyCurrentAuthority: async () => ({ allowed: true }),
        withAuthorityFence: async (write) => write(),
      },
    );
    assert.ok(writes.some((mutation) => mutation.connector === "documents"));
    assert.ok(!writes.some((mutation) => mutation.connector === "payroll"));
  });
});
