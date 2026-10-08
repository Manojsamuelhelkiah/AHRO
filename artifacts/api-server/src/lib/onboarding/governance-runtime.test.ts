import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import {
  db,
  onbApprovals,
  onbCases,
  onbGovernanceDecisions,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  onbSensitiveLifecyclePolicies,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION,
  GOVERNANCE_DECISION_RUNTIME_CATALOG,
  GovernanceCaseRebaseConflictError,
  adoptGovernanceDecisionSnapshot,
  assessGovernanceCaseImpact,
  evaluateGovernanceExecutionGate,
  executionContextForStoredCase,
  governanceWorkflowForConnectorMutation,
  governanceDecisionSnapshotFromPolicy,
  prepareGovernanceCaseRebase,
  rebaseGovernanceCase,
  standardNewHireForStoredCase,
  withGovernanceDecisionSnapshot,
} from "./governance-runtime";
import {
  hasTrustedBgvClearanceEvidence,
  hasTrustedHrisActivationEvidence,
  hasTrustedProviderConfiguration,
} from "./connector-evidence-provenance";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const legalAccess = {
  key: "lawful-access-release",
  revision: 1,
  status: "provisional" as const,
  domain: "legal" as const,
  impactedWorkflows: ["it-identity-access"],
};

describe("governance runtime execution gates", () => {
  test("blocks only affected live actions for an unapproved sensitive decision", () => {
    const blocked = evaluateGovernanceExecutionGate({
      workflow: "it-identity-access",
      execution: executionContextForStoredCase({ isolatedSimulation: false }),
      decisions: [legalAccess],
    });
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.blockers.map((blocker) => blocker.kind), ["unapproved-sensitive-decision"]);

    const unaffected = evaluateGovernanceExecutionGate({
      workflow: "payroll-benefits",
      execution: executionContextForStoredCase({ isolatedSimulation: false }),
      decisions: [legalAccess],
    });
    assert.equal(unaffected.allowed, true);
  });

  test("allows server-classified isolated simulation through governance review without reopening provider denies", () => {
    const simulated = evaluateGovernanceExecutionGate({
      workflow: "it-identity-access",
      execution: executionContextForStoredCase({ isolatedSimulation: true }),
      decisions: [legalAccess],
      standardHireAccess: { standardNewHire: true, bgvClear: false, hrisActive: false },
    });
    assert.deepEqual(simulated, {
      allowed: true,
      execution: "isolated-simulation",
      blockers: [],
    });
    const preservedProviderDeny = evaluateGovernanceExecutionGate({
      workflow: "it-identity-access",
      execution: executionContextForStoredCase({ isolatedSimulation: true }),
      decisions: [legalAccess],
      providerDispatchDenied: true,
    });
    assert.equal(preservedProviderDeny.allowed, false);
    assert.equal(preservedProviderDeny.blockers[0]?.kind, "provider-policy-denied");
  });

  test("keeps live approval, provider configuration, evidence, and provider denies separate", () => {
    const result = evaluateGovernanceExecutionGate({
      workflow: "it-identity-access",
      execution: executionContextForStoredCase({ isolatedSimulation: false }),
      decisions: [{
        ...legalAccess,
        status: "approved",
      }],
      requirements: [{
        key: "iam-production",
        impactedWorkflows: ["it-identity-access"],
        coverage: { implemented: true, tested: true, configured: true, approvedForLive: false },
        providerConfigured: false,
        realEvidenceAvailable: false,
      }],
      providerDispatchDenied: true,
    });
    assert.deepEqual(result.blockers.map((blocker) => blocker.kind), [
      "provider-policy-denied",
      "requirement-not-approved-for-live",
      "requirement-not-configured",
      "provider-not-configured",
      "evidence-not-available",
    ]);
  });

  test("requires both BGV and active HRIS for standard new-hire live access or assets", () => {
    const result = evaluateGovernanceExecutionGate({
      workflow: "assets-workplace",
      execution: executionContextForStoredCase({ isolatedSimulation: false }),
      decisions: [],
      standardHireAccess: { standardNewHire: true, bgvClear: false, hrisActive: false },
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.blockers.map((blocker) => blocker.kind), ["bgv-not-clear", "hris-not-active"]);
  });

  test("uses server case facts and connector identity for standard hire scope", () => {
    assert.equal(standardNewHireForStoredCase({
      hireType: "external-fte",
      workerCategory: "employee",
    }), true);
    assert.equal(standardNewHireForStoredCase({
      hireType: "external-fte",
      workerCategory: "contractor",
    }), false);
    assert.equal(governanceWorkflowForConnectorMutation({
      connector: "iam",
      operation: "provision-account",
    }), "it-identity-access");
  });

  test("uses immutable catalog scopes, never mutable human workflow labels", () => {
    assert.deepEqual(GOVERNANCE_DECISION_RUNTIME_CATALOG["GD-10"], {
      domain: "privacy",
      impactedWorkflows: [
        "worker-record-documents",
        "payroll-benefits",
        "frontline-deployment",
        "candidate-communications",
        "candidate-voice",
        "candidate-portal",
      ],
    });
    const blocked = evaluateGovernanceExecutionGate({
      workflow: "worker-record-documents",
      execution: { kind: "live" },
      decisions: [{
        key: "GD-10",
        revision: 1,
        status: "provisional",
        domain: GOVERNANCE_DECISION_RUNTIME_CATALOG["GD-10"]!.domain,
        impactedWorkflows: GOVERNANCE_DECISION_RUNTIME_CATALOG["GD-10"]!.impactedWorkflows,
      }],
    });
    assert.equal(blocked.allowed, false);
  });

  test("rejects simulated connector, BGV, and human HRIS status labels as live provenance", () => {
    assert.equal(hasTrustedProviderConfiguration({
      status: "connected", lastSyncAt: new Date(), configurationProvenance: "simulated",
    }), false);
    assert.equal(hasTrustedBgvClearanceEvidence([{
      system: "bgv", status: "done", mode: "push", externalRef: "SIM-1",
      completedAt: new Date(), evidenceProvenance: "simulated",
    }]), false);
    assert.equal(hasTrustedHrisActivationEvidence({
      complete: true, evidenceProvenance: "human-authorized", snapshotVersion: 1,
      sourceStartDate: "2030-01-01", sourceEvidenceRevision: "human-assertion",
    }, { joiningDate: "2030-01-01", snapshotVersion: 1 }), false);
  });
});

describe("governance case snapshots", () => {
  test("adopts approved revisions without rewriting the existing case policy", () => {
    const adopted = adoptGovernanceDecisionSnapshot({
      decisions: [{ ...legalAccess, status: "approved" }],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    const original = { processPolicy: { semanticsVersion: 2 }, retained: { value: true } };
    const policy = withGovernanceDecisionSnapshot(original, adopted);
    assert.equal(adopted.schemaVersion, GOVERNANCE_CASE_SNAPSHOT_SCHEMA_VERSION);
    assert.deepEqual(original, { processPolicy: { semanticsVersion: 2 }, retained: { value: true } });
    assert.deepEqual(governanceDecisionSnapshotFromPolicy(policy), adopted);
  });

  test("snapshots provisional state so absence of approval cannot hide an applicable decision", () => {
    const snapshot = adoptGovernanceDecisionSnapshot({
      decisions: [legalAccess],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(snapshot.decisions[0]?.status, "provisional");
    assert.equal(evaluateGovernanceExecutionGate({
      workflow: "it-identity-access",
      execution: { kind: "live" },
      decisions: snapshot.decisions,
    }).allowed, false);
  });

  test("lists a later approved revision as prospective and revocation as a live impact", () => {
    const snapshot = adoptGovernanceDecisionSnapshot({
      decisions: [{ ...legalAccess, status: "approved" }],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.deepEqual(assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: [{ ...legalAccess, revision: 2, status: "approved" }],
    }), [{
      key: legalAccess.key,
      adoptedRevision: 1,
      currentRevision: 2,
      impactedWorkflows: ["it-identity-access"],
      reason: "revision-available",
      blocksLiveActions: false,
    }]);
    assert.equal(assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: [{ ...legalAccess, revision: 2, status: "rejected" }],
    })[0]?.blocksLiveActions, false);
    assert.equal(assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: [{ ...legalAccess, revision: 1, status: "rejected" }],
    })[0]?.blocksLiveActions, true);
  });

  test("shows a same-revision later approval as prospective until rebase", () => {
    const snapshot = adoptGovernanceDecisionSnapshot({
      decisions: [legalAccess],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.deepEqual(assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: [{ ...legalAccess, status: "approved" }],
    }), [{
      key: legalAccess.key,
      adoptedRevision: 1,
      currentRevision: 1,
      impactedWorkflows: ["it-identity-access"],
      reason: "revision-available",
      blocksLiveActions: false,
    }]);
  });

  test("an adopted approval's revoked authority remains blocking after a newer revision", () => {
    const snapshot = adoptGovernanceDecisionSnapshot({
      decisions: [{ ...legalAccess, status: "approved" }],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    const impacts = assessGovernanceCaseImpact({
      snapshot,
      currentDecisions: [{ ...legalAccess, revision: 2, status: "approved", reviewerAuthorityActive: false }],
    });
    assert.equal(impacts[0]?.reason, "approval-revoked-or-missing");
    assert.equal(impacts[0]?.blocksLiveActions, true);
    assert.equal(impacts[0]?.adoptedRevision, 1);
    assert.equal(impacts[0]?.currentRevision, 2);
  });

  test("requires a version-checked rebase and new final approval", () => {
    const snapshot = adoptGovernanceDecisionSnapshot({
      decisions: [{ ...legalAccess, status: "approved" }],
      adoptedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.throws(() => prepareGovernanceCaseRebase({
      currentSnapshot: snapshot,
      expectedSnapshotVersion: 2,
      currentDecisions: [{ ...legalAccess, revision: 2, status: "approved" }],
      adoptedAt: "2030-02-01T00:00:00.000Z",
    }), GovernanceCaseRebaseConflictError);
    const rebased = prepareGovernanceCaseRebase({
      currentSnapshot: snapshot,
      expectedSnapshotVersion: 1,
      currentDecisions: [{ ...legalAccess, revision: 2, status: "approved" }],
      adoptedAt: "2030-02-01T00:00:00.000Z",
    });
    assert.equal(rebased.nextSnapshot.version, 2);
    assert.equal(rebased.freshFinalApprovalRequired, true);
  });
});

describe("governance case rebase persistence", { concurrency: false }, () => {
  test("uses audited legacy v0 adoption, preserves policy, and rejects stale rebases", async () => {
    const organizationId = `governance-rebase-${process.pid}-${randomUUID()}`;
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Governance rebase test",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: "test",
    });
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    try {
      const [legacy] = await db.insert(onbCases).values({
        organizationId, workerName: "Legacy governed case", workerEmail: `${organizationId}@example.invalid`,
        workerCategory: "employee", hireType: "external-fte", role: "Engineer", department: "Technology",
        geography: "United Kingdom", legalEntity: "Example Ltd", managerName: "Manager",
        recruiterName: "Recruiter", joiningDate: "2030-01-01", lifecycleStage: "plan-generated",
        orchestrationStatus: "idle", readiness: [], workstreams: [],
        workforceContext: { workCountry: "US" },
        processPolicySnapshot: { retainedPolicy: { immutable: true } },
      }).returning();
      const adopted = await rebaseGovernanceCase({
        organizationId, caseId: legacy!.id, expectedSnapshotVersion: 0,
        reason: "Explicit legacy adoption before sensitive live action", changedBy: "test reviewer",
      });
      assert.equal(adopted.version, 0);
      const [stored] = await db.select({ processPolicySnapshot: onbCases.processPolicySnapshot })
        .from(onbCases).where(eq(onbCases.id, legacy!.id));
      assert.deepEqual((stored!.processPolicySnapshot as { retainedPolicy: unknown }).retainedPolicy, { immutable: true });
      await assert.rejects(
        rebaseGovernanceCase({
          organizationId, caseId: legacy!.id, expectedSnapshotVersion: 3,
          reason: "Stale replacement", changedBy: "test reviewer",
        }),
        GovernanceCaseRebaseConflictError,
      );
    } finally {
      await db.delete(onbApprovals).where(eq(onbApprovals.organizationId, organizationId));
      await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
      await db.delete(onbGovernanceReminders).where(eq(onbGovernanceReminders.organizationId, organizationId));
      await db.delete(onbGovernanceHistory).where(eq(onbGovernanceHistory.organizationId, organizationId));
      await db.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, organizationId));
      await db.delete(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, organizationId));
      await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
      await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
    }
  });
});