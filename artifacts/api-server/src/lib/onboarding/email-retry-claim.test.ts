import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { onbCases, onbCommunications, onbEffectJournal, onbGovernanceAuthorityAssignments, onbGovernanceDecisionReviews, onbGovernanceDecisions, onbGovernanceDispatchMarkers, onbGovernanceRequirements, onbSensitiveLifecyclePolicies, organizationsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { retryCandidateEmail } from "./channels";
import { refreshDemoAllowlist } from "./recipient-allowlist";
const HR_APPROVER_SETTING_KEY = "hr_approver_email";
import { getSetting, setSetting } from "./settings";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";
import { governanceSnapshotForNewCase, withGovernanceDecisionSnapshot, type GovernanceCaseSnapshot } from "./governance-runtime";
import { dispatchWithProviderGovernance, PROVIDER_GOVERNANCE_WORKFLOW } from "./governance-provider-boundary";

const hasDb = Boolean(process.env.DATABASE_URL);
const DEMO_ORGANIZATION_ID = `email-retry-claim-${process.pid}`;
let governanceSnapshot: GovernanceCaseSnapshot;
const caseIds: number[] = [];
describe("email retry durable claim", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(organizationsTable).values({
      id: DEMO_ORGANIZATION_ID, name: "Email retry claim test", slug: DEMO_ORGANIZATION_ID,
      joinCodeHash: `hash-${DEMO_ORGANIZATION_ID}`, createdByUserId: "email-retry-claim-test",
    });
    await seedApprovedSensitiveLifecyclePolicies(DEMO_ORGANIZATION_ID, { permittedProviders: ["gmail"] });
    await governanceSnapshotForNewCase(DEMO_ORGANIZATION_ID);
    const decisions = await db.select().from(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, DEMO_ORGANIZATION_ID));
    for (const decision of decisions) {
      const reviewer = `email-retry-fixture:${decision.accountableRole}`;
      const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
        organizationId: DEMO_ORGANIZATION_ID, authorityRole: decision.accountableRole, assigneeUserId: reviewer,
        verificationStatus: "verified", verifiedByUserId: "email-retry-fixture", verificationReference: reviewer,
      }).returning({ id: onbGovernanceAuthorityAssignments.id });
      await db.insert(onbGovernanceDecisionReviews).values({
        organizationId: DEMO_ORGANIZATION_ID, decisionKey: decision.key, decisionRevision: decision.revision,
        outcome: "approved", reason: "Stubbed email provider fixture approval", authorityAssignmentId: authority!.id,
        reviewedByUserId: reviewer, verificationReference: reviewer,
      });
      await db.update(onbGovernanceDecisions).set({ status: "approved", approvedByUserId: reviewer, approvedAt: new Date() })
        .where(and(eq(onbGovernanceDecisions.organizationId, DEMO_ORGANIZATION_ID), eq(onbGovernanceDecisions.key, decision.key), eq(onbGovernanceDecisions.revision, decision.revision)));
    }
    await db.update(onbGovernanceRequirements).set({ implemented: true, tested: true, configured: true, approvedForLive: true })
      .where(eq(onbGovernanceRequirements.organizationId, DEMO_ORGANIZATION_ID));
    governanceSnapshot = await governanceSnapshotForNewCase(DEMO_ORGANIZATION_ID);
  });
  after(async () => {
    for (const caseId of caseIds) {
      await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId));
      await db.delete(onbCases).where(eq(onbCases.id, caseId));
    }
    await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, DEMO_ORGANIZATION_ID));
    await db.delete(onbGovernanceDecisionReviews).where(eq(onbGovernanceDecisionReviews.organizationId, DEMO_ORGANIZATION_ID));
    await db.delete(onbGovernanceAuthorityAssignments).where(eq(onbGovernanceAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID));
    await db.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, DEMO_ORGANIZATION_ID));
    await db.delete(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, DEMO_ORGANIZATION_ID));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID));
    await deleteTestOrganizations(eq(organizationsTable.id, DEMO_ORGANIZATION_ID));
  });

  test("two concurrent retries claim one row and invoke the injected provider once", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Email Retry Claim__",
      workerEmail: "retry-claim@example.com",
      channelPreference: "email",
      candidateEmailAuthorizedAt: new Date(),
      candidateEmailAuthorizedBy: "test-reviewer",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
        workforceContext: { workCountry: "US" },
        processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Original durable body",
        status: "failed",
        failureReason: "Gmail 500: test failure",
      }).returning({ id: onbCommunications.id });
      let providerCalls = 0;
      const fakeProvider = async (_to: string, _subject: string, _body: string) => {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "sent", failureReason: null, externalMessageId: "fake-message-id" };
      };
      const [first, second] = await Promise.all([
        retryCandidateEmail(c.id, message.id, "reviewer-a", fakeProvider),
        retryCandidateEmail(c.id, message.id, "reviewer-b", fakeProvider),
      ]);
      assert.equal([first, second].filter((r) => r.ok).length, 1);
      assert.equal(providerCalls, 1);
      const [stored] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, message.id));
      assert.equal(stored.status, "sent");
      assert.equal(stored.externalMessageId, "fake-message-id");
      assert.equal(stored.body, "Original durable body");
    } finally {
      await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id));
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
    }
  });

  test("a claimed retry stopped by the live-send cap is logged-only and never invokes provider", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Capped Email Retry__",
      workerEmail: "retry-capped@example.com",
      channelPreference: "email",
      candidateEmailAuthorizedAt: new Date(),
      candidateEmailAuthorizedBy: "test-reviewer",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
        workforceContext: { workCountry: "US" },
        processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Original capped body",
        status: "failed",
        failureReason: "Gmail 500: test failure",
      }).returning({ id: onbCommunications.id });
      let providerCalls = 0;
      const fakeProvider = async (_to: string, _subject: string, _body: string) => {
        providerCalls += 1;
        return { status: "sent", failureReason: null, externalMessageId: "must-not-send" };
      };
      const result = await retryCandidateEmail(
        c.id,
        message.id,
        "reviewer",
        fakeProvider,
        () => false,
      );
      assert.equal(result.ok, true);
      assert.equal(providerCalls, 0);
      const [stored] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, message.id));
      assert.equal(stored.status, "logged-only");
      assert.equal(stored.failureReason, "Hourly live-send limit reached — message logged, not delivered.");
      assert.equal(stored.body, "Original capped body");
    } finally {
      await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id));
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
    }
  });

  test("retry refreshes the configured HR recipient without case autoauthorization", async () => {
    const previousVolunteers = await getSetting(DEMO_ORGANIZATION_ID, HR_APPROVER_SETTING_KEY);
    const email = "retry-volunteer@example.com";
    await setSetting(DEMO_ORGANIZATION_ID, HR_APPROVER_SETTING_KEY, email);
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Volunteer Retry__",
      workerEmail: email,
      channelPreference: "email",
      candidateEmailAuthorizedAt: null,
      candidateEmailAuthorizedBy: null,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
        workforceContext: { workCountry: "US" },
        processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Volunteer body",
        status: "logged-only",
        failureReason: "Previously blocked",
      }).returning({ id: onbCommunications.id });
      let deliveredTo = "";
      const result = await retryCandidateEmail(
        c.id,
        message.id,
        "reviewer",
        async (to) => {
          deliveredTo = to;
          return { status: "sent", failureReason: null, externalMessageId: "fake-volunteer-message" };
        },
        () => true,
      );
      assert.equal(result.ok, true);
      assert.equal(deliveredTo, email);
    } finally {
      await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id));
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
      await setSetting(DEMO_ORGANIZATION_ID, HR_APPROVER_SETTING_KEY, previousVolunteers);
      await refreshDemoAllowlist(DEMO_ORGANIZATION_ID);
    }
  });

  test("provider dispatch reloads a corrected jurisdiction before external I/O", async () => {
    const usPolicies = await db.select().from(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
    ));
    await db.insert(onbSensitiveLifecyclePolicies).values(usPolicies.map((policy) => ({
      organizationId: policy.organizationId,
      dataClass: policy.dataClass,
      jurisdiction: "GB",
      revision: policy.revision,
      purpose: policy.purpose,
      lawfulBasis: policy.lawfulBasis,
      retentionDays: policy.retentionDays,
      providerSharingApproved: policy.providerSharingApproved,
      permittedProviders: policy.permittedProviders,
      policyReference: `${policy.policyReference}:GB`,
      approvalReference: `${policy.approvalReference}:GB`,
      approvedByUserId: policy.approvedByUserId,
      approvedAuthorityAssignmentId: policy.approvedAuthorityAssignmentId,
      isCurrent: policy.isCurrent,
      supersededAt: policy.supersededAt,
    })));
    const [caseRow] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test stale provider jurisdiction__",
      workerEmail: "stale-provider-jurisdiction@example.com",
      channelPreference: "email",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
      processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
    }).returning();
    caseIds.push(caseRow.id);
    let providerCalls = 0;
    await db.update(onbCases).set({
      workforceContext: { workCountry: "GB" },
      workforceContextVersion: caseRow.workforceContextVersion + 1,
    })
      .where(eq(onbCases.id, caseRow.id));
    const result = await dispatchWithProviderGovernance({
      caseRow,
      workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
      operation: `stale-jurisdiction:${caseRow.id}`,
      providerId: "gmail",
      dispatch: async () => { providerCalls += 1; return "sent"; },
      disposition: () => "sent",
    });
    assert.equal(result.dispatched, false);
    assert.equal(providerCalls, 0);
  });

  test("contact-only Gmail approval cannot disclose an opaque mixed candidate message", async () => {
    // Keep candidate-contact approved for Gmail but remove Gmail disclosure
    // approval for medical data. Arbitrary email body text is opaque, so the
    // final provider boundary must require both classes and make no call.
    await db.update(onbSensitiveLifecyclePolicies).set({
      providerSharingApproved: false,
      permittedProviders: [],
    }).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSensitiveLifecyclePolicies.dataClass, "medical"),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
    ));
    const [caseRow] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test opaque mixed message__",
      workerEmail: "mixed-message@example.com",
      channelPreference: "email",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
      processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
    }).returning();
    caseIds.push(caseRow.id);
    let providerCalls = 0;
    const result = await dispatchWithProviderGovernance({
      caseRow,
      workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
      operation: `opaque-mixed-message:${caseRow.id}`,
      providerId: "gmail",
      dispatch: async () => { providerCalls += 1; return "sent"; },
      disposition: () => "sent",
    });
    assert.equal(result.dispatched, false);
    assert.equal(providerCalls, 0);
    await db.update(onbSensitiveLifecyclePolicies).set({
      providerSharingApproved: true,
      permittedProviders: ["gmail"],
    }).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSensitiveLifecyclePolicies.dataClass, "medical"),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
    ));
  });

  test("a current workforce policy-rebase hold blocks provider I/O", async () => {
    const [caseRow] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test provider rebase hold__",
      workerEmail: "provider-rebase-hold@example.com",
      channelPreference: "email",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      workforceContext: { workCountry: "US" },
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
      processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
      checklistSnapshot: [{
        id: "policy-rebase-required",
        label: "Policy rebase required",
        order: 1,
        enabled: true,
        mandatory: true,
        evidenceRequired: false,
        enforcementStage: "before-workstreams",
        responsibleRole: "hr",
        completionAuthority: "designated-human",
      }],
      readiness: [{ key: "policy-rebase-required", label: "Policy rebase required", status: "pending" }],
    }).returning();
    caseIds.push(caseRow.id);
    let providerCalls = 0;
    const result = await dispatchWithProviderGovernance({
      caseRow,
      workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
      operation: `policy-rebase-hold:${caseRow.id}`,
      providerId: "gmail",
      dispatch: async () => { providerCalls += 1; return "sent"; },
      disposition: () => "sent",
    });
    assert.equal(result.dispatched, false);
    assert.equal(providerCalls, 0);
  });
});