import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { after, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { dkimSign, type DNSResolver } from "mailauth";
import {
  db,
  onbApprovalHistory,
  onbApprovalNotifications,
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  authorityScopeForApproval,
  decisionAuthorityStillCurrent,
  verifyDecisionAuthorityInTransaction,
} from "./decision-authority";
import { decideApproval } from "./approval-decisions";
import { reopenApprovalInTransaction } from "./approval-version";
import { verifyGmailApprovalTransport } from "./verified-email-transport";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `authority-security-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-tenant`;
const otherOrganizationId = `${suffix}-other-tenant`;

async function createOrganization(id: string) {
  await db.insert(organizationsTable).values({
    id,
    name: id,
    slug: id,
    joinCodeHash: `${id}-join`,
    createdByUserId: "test-owner",
  });
}

async function createCase(org: string, createdByUserId: string | null = "case-requester") {
  const [c] = await db.insert(onbCases).values({
    organizationId: org,
    workerName: "Authority security fixture",
    workerEmail: `${randomUUID()}@example.test`,
    hireType: "employee",
    workerCategory: "employee",
    role: "Engineer",
    department: "Security",
    geography: "US",
    legalEntity: "Example US",
    managerName: "Manager",
    recruiterName: "Requester",
    createdByUserId,
    joiningDate: "2031-01-01",
    lifecycleStage: "preboarding",
    orchestrationStatus: "waiting-approval",
  }).returning();
  return c;
}

/** Build the same raw, signed transport proof the Gmail adapter supplies. */
async function signedRemoteApprovalProof(input: {
  approvalId: number;
  version: number;
  sourceMessageId: string;
}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const reference = `AP-${input.approvalId}-V${input.version}`;
  const rawMessage = [
    "From: Legal Specialist <legal@example.test>",
    "To: approvals@example.test",
    `Subject: [${reference}] Decision`,
    "Date: Tue, 01 Jan 2030 00:00:00 +0000",
    "",
    reference,
    "approve",
    "",
  ].join("\r\n");
  const privatePem = privateKey.export({ type: "pkcs1", format: "pem" });
  const signed = await dkimSign(rawMessage, {
    signingDomain: "example.test",
    selector: "authority-test",
    privateKey: privatePem,
    signatureData: [{
      signingDomain: "example.test",
      selector: "authority-test",
      privateKey: privatePem,
      headerList: ["from", "subject"],
    }],
  });
  assert.deepEqual(signed.errors, []);
  const publicKeyText = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const resolver: DNSResolver = async (domain) => {
    assert.equal(domain, "authority-test._domainkey.example.test");
    return [[`v=DKIM1; k=rsa; p=${publicKeyText}`]];
  };
  const proof = await verifyGmailApprovalTransport({
    rawMessage: `${signed.signatures}${rawMessage}`,
    sourceMessageId: input.sourceMessageId,
    expectedFromAddress: "legal@example.test",
    expectedReference: reference,
    expectedDecisionText: "approve",
    expectedDecision: "approved",
    resolver,
  });
  assert.ok(proof, "fixture must produce a valid raw Gmail DKIM proof");
  return proof;
}

describe("verified specialist authority security boundaries (real DB)", { skip: !hasDb }, () => {
  after(async () => {
    await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
    await db.delete(onbCases).where(eq(onbCases.organizationId, otherOrganizationId));
    await db.delete(organizationsTable).where(and(
      eq(organizationsTable.id, organizationId),
    ));
    await db.delete(organizationsTable).where(and(
      eq(organizationsTable.id, otherOrganizationId),
    ));
  });

  test("rejects forged, cross-tenant, requester, wrong-scope, expired, revoked, and stale authority", async () => {
    await createOrganization(organizationId);
    await createOrganization(otherOrganizationId);
    const c = await createCase(organizationId);
    const [approval] = await db.insert(onbApprovals).values({
      organizationId,
      caseId: c.id,
      agent: "legal",
      ruleRef: "Legal policy transfer decision",
      hitlPattern: "hard-block",
      recommendation: "Approve legal transfer exception",
      rationale: "Fixture",
      resumeAction: "none",
      authorityScope: "legal-approve",
      requestedByUserId: "requester",
      idempotencyKey: `${suffix}-approval`,
    }).returning();
    await db.insert(onbAuthorityGovernance).values({
      organizationId,
      status: "governance-approved",
      approvedByUserId: "external-governance",
      approvedAt: new Date(),
      governanceSource: "test",
      revision: 1,
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId,
      clerkUserId: "legal-specialist",
      role: "member",
    });
    const [assignment] = await db.insert(onbAuthorityAssignments).values({
      id: `${suffix}-legal`,
      organizationId,
      personUserId: "legal-specialist",
      personEmail: "legal@example.test",
      emailResponderAuthorized: true,
      authorityRole: "legal",
      scopes: ["legal-approve"],
      caseId: c.id,
      siteScope: "US",
      jurisdictionScope: "Example US",
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      status: "active",
      revision: 1,
      grantorUserId: "governance-admin",
      source: "test",
      governanceDecisionRef: "GOV-TEST",
    }).returning();

    const authorize = (actorUserId?: string, responderEmail?: string) =>
      db.transaction((tx) => verifyDecisionAuthorityInTransaction(tx, {
        organizationId,
        approval,
        actorUserId,
        responderEmail,
      }));
    assert.equal((await authorize("legal-specialist")).allowed, true);
    assert.equal((await authorize("forged-user")).allowed, false, "forged identity");
    assert.equal((await authorize("requester")).allowed, false, "requester cannot self-approve");
    assert.equal((await authorize(undefined, "shared-mailbox@example.test")).allowed, false, "unassigned mailbox");
    const originalGetUserList = clerkClient.users.getUserList;
    (clerkClient.users as unknown as { getUserList: typeof clerkClient.users.getUserList }).getUserList =
      (async () => ({
        data: [{
          id: "legal-specialist",
          emailAddresses: [{
            emailAddress: "legal@example.test",
            verification: { status: "verified" },
          }],
        }],
      })) as typeof clerkClient.users.getUserList;
    try {
      const remote = await authorize(undefined, "legal@example.test");
      assert.equal(remote.allowed, true, "exact verified Clerk member may decide by email");
      if (remote.allowed) assert.equal(remote.personUserId, "legal-specialist");
      const sourceMessageId = `${suffix}-authorized-email`;
      const transport = await signedRemoteApprovalProof({
        approvalId: approval.id,
        version: approval.version,
        sourceMessageId,
      });
      const remoteDecision = await decideApproval({
        organizationId,
        approvalId: approval.id,
        decision: "approved",
        expectedVersion: approval.version,
        decidedBy: "forged mailbox persona",
        responderEmail: "legal@example.test",
        sourceAddress: "legal@example.test",
        sourceMessageId,
        transport,
      });
      assert.equal(remoteDecision.outcome, "decided");
      if (remoteDecision.outcome === "decided") {
        assert.equal(remoteDecision.approval.decidedBy, "legal-specialist", "email decision audit uses actual Clerk principal");
        assert.equal(remoteDecision.approval.decidedAuthorityId, assignment.id);
        assert.equal(remoteDecision.approval.decidedAuthorityRevision, 1);
      }
      // Simulate a poller crash after decideApproval committed but before it
      // persisted the inbound Gmail message. A retry must replay the original
      // durable success rather than turning into a stale/no-decision response
      // or creating a second receipt.
      const retryAfterCommit = await decideApproval({
        organizationId,
        approvalId: approval.id,
        decision: "approved",
        expectedVersion: approval.version,
        decidedBy: "forged mailbox persona",
        responderEmail: "legal@example.test",
        sourceAddress: "legal@example.test",
        sourceMessageId,
        transport,
      });
      assert.equal(retryAfterCommit.outcome, "decided");
      const durableReceipts = await db.select().from(onbApprovalNotifications).where(and(
        eq(onbApprovalNotifications.organizationId, organizationId),
        eq(onbApprovalNotifications.approvalId, approval.id),
        eq(onbApprovalNotifications.sourceMessageId, sourceMessageId),
        eq(onbApprovalNotifications.idempotencyKey, `approval-email-receipt:${sourceMessageId}`),
      ));
      assert.equal(durableReceipts.length, 1, "one source-message keyed receipt survives the retry");
      assert.equal(durableReceipts[0]?.kind, "decision");
      assert.equal(durableReceipts[0]?.version, approval.version);
      assert.match(durableReceipts[0]?.subject ?? "", /Email decision recorded — approved/);
      const [historyBeforeReopen] = await db.select().from(onbApprovalHistory).where(and(
        eq(onbApprovalHistory.organizationId, organizationId),
        eq(onbApprovalHistory.approvalId, approval.id),
      ));
      assert.equal(historyBeforeReopen.decidedBy, "legal-specialist");
      assert.equal((historyBeforeReopen.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, assignment.id);
      assert.equal((historyBeforeReopen.snapshot as { decidedAuthorityRevision?: number }).decidedAuthorityRevision, 1);
      await db.transaction((tx) => reopenApprovalInTransaction(tx, {
        organizationId, caseId: approval.caseId, approvalId: approval.id,
        reason: "Remote-email history retention fixture", actor: "test",
      }));
      const historyAfterReopen = await db.select().from(onbApprovalHistory).where(and(
        eq(onbApprovalHistory.organizationId, organizationId),
        eq(onbApprovalHistory.approvalId, approval.id),
      ));
      assert.equal(historyAfterReopen[0]?.decidedBy, "legal-specialist");
      assert.equal((historyAfterReopen[0]?.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, assignment.id);
      const retryAfterReopen = await decideApproval({
        organizationId,
        approvalId: approval.id,
        decision: "approved",
        expectedVersion: approval.version,
        decidedBy: "forged mailbox persona",
        responderEmail: "legal@example.test",
        sourceAddress: "legal@example.test",
        sourceMessageId,
        transport,
      });
      assert.equal(retryAfterReopen.outcome, "decided", "the original source message replays after reopen");
      const receiptsAfterReopen = await db.select().from(onbApprovalNotifications).where(and(
        eq(onbApprovalNotifications.organizationId, organizationId),
        eq(onbApprovalNotifications.approvalId, approval.id),
        eq(onbApprovalNotifications.sourceMessageId, sourceMessageId),
        eq(onbApprovalNotifications.idempotencyKey, `approval-email-receipt:${sourceMessageId}`),
      ));
      assert.equal(receiptsAfterReopen.length, 1);
      assert.equal(receiptsAfterReopen[0]?.version, approval.version, "receipt retains the original decision cycle");
      const inAppDecision = await decideApproval({
        organizationId, approvalId: approval.id, expectedVersion: 2,
        decision: "approved", decidedBy: "Legal reviewer display label",
        actorUserId: "legal-specialist",
      });
      assert.equal(inAppDecision.outcome, "decided", "reopened review remains eligible for the same verified in-app specialist");
      if (inAppDecision.outcome === "decided") assert.equal(inAppDecision.approval.decidedBy, "legal-specialist");
      const historyAfterBothChannels = await db.select().from(onbApprovalHistory).where(and(
        eq(onbApprovalHistory.organizationId, organizationId),
        eq(onbApprovalHistory.approvalId, approval.id),
      ));
      const decisionHistory = historyAfterBothChannels.filter((row) => row.eventType === "decision");
      assert.equal(decisionHistory.length, 2, "email and authenticated app decisions retain separate immutable records");
      assert.equal(decisionHistory[0]?.decidedBy, "legal-specialist");
      assert.equal((decisionHistory[0]?.snapshot as { decidedAuthorityId?: string }).decidedAuthorityId, assignment.id);
    } finally {
      (clerkClient.users as unknown as { getUserList: typeof clerkClient.users.getUserList }).getUserList = originalGetUserList;
    }
    assert.equal((await db.transaction((tx) => verifyDecisionAuthorityInTransaction(tx, {
      organizationId: otherOrganizationId,
      approval,
      actorUserId: "legal-specialist",
    }))).allowed, false, "tenant mismatch");

    await db.update(onbAuthorityAssignments).set({ authorityRole: "payroll" })
      .where(eq(onbAuthorityAssignments.id, assignment.id));
    assert.equal((await authorize("legal-specialist")).allowed, false, "role-to-scope matrix rejects forged mixed-role assignment");
    await db.update(onbAuthorityAssignments).set({ authorityRole: "legal" })
      .where(eq(onbAuthorityAssignments.id, assignment.id));

    const [medicalScope] = await db.update(onbApprovals).set({
      authorityScope: "occupational-health-approve",
    }).where(eq(onbApprovals.id, approval.id)).returning();
    assert.equal((await db.transaction((tx) => verifyDecisionAuthorityInTransaction(tx, {
      organizationId,
      approval: medicalScope,
      actorUserId: "legal-specialist",
    }))).allowed, false, "legal authority cannot clear medical gate");
    await db.update(onbApprovals).set({ authorityScope: "legal-approve" }).where(eq(onbApprovals.id, approval.id));

    await db.update(onbAuthorityAssignments).set({ validUntil: new Date(Date.now() - 1) })
      .where(eq(onbAuthorityAssignments.id, assignment.id));
    assert.equal((await authorize("legal-specialist")).allowed, false, "expired assignment");
    await db.update(onbAuthorityAssignments).set({ validUntil: new Date(Date.now() + 60_000), status: "revoked", revision: 2 })
      .where(eq(onbAuthorityAssignments.id, assignment.id));
    assert.equal((await authorize("legal-specialist")).allowed, false, "revoked assignment");

    const [decided] = await db.update(onbApprovals).set({
      status: "approved",
      decidedAuthorityId: assignment.id,
      decidedAuthorityRevision: 1,
    }).where(eq(onbApprovals.id, approval.id)).returning();
    assert.equal(await db.transaction((tx) => decisionAuthorityStillCurrent(tx, decided)), false, "revoked/revision-changed decision cannot continue");
  });

  test("classifies legal and medical gates to designated scopes", () => {
    assert.equal(authorityScopeForApproval({ ruleRef: "Legal transfer policy approval" }), "legal-approve");
    assert.equal(authorityScopeForApproval({ recommendation: "Medical safety clearance required" }), "occupational-health-approve");
  });

  test("decision intake rejects self-approval and missing durable requester provenance", async () => {
    const org = `${suffix}-sod`;
    await createOrganization(org);
    const c = await createCase(org, null);
    const [approval] = await db.insert(onbApprovals).values({
      organizationId: org,
      caseId: c.id,
      agent: "SoD fixture",
      ruleRef: "SoD fixture",
      hitlPattern: "approve-before-act",
      recommendation: "Review",
      rationale: "Fixture",
      resumeAction: "none",
      authorityScope: "hr-compliance-approve",
      requestedByUserId: "requester-principal",
      idempotencyKey: `${suffix}-sod-approval`,
    }).returning();
    await db.insert(onbAuthorityGovernance).values({
      organizationId: org, status: "governance-approved", approvedByUserId: "test",
      approvedAt: new Date(), governanceSource: "test", revision: 1,
    });
    await db.insert(organizationMembershipsTable).values({
      organizationId: org, clerkUserId: "requester-principal", role: "member",
    });

    const selfDecision = await decideApproval({
      organizationId: org, approvalId: approval.id, expectedVersion: 1,
      decision: "approved", decidedBy: "requester-principal",
      actorUserId: "requester-principal",
    });
    assert.deepEqual(selfDecision, {
      outcome: "unauthorized", reason: "separation_of_duties_requester_conflict",
    });

    await db.update(onbApprovals).set({ requestedByUserId: null })
      .where(eq(onbApprovals.id, approval.id));
    const provenanceDecision = await decideApproval({
      organizationId: org, approvalId: approval.id, expectedVersion: 1,
      decision: "approved", decidedBy: "requester-principal",
      actorUserId: "requester-principal",
    });
    assert.deepEqual(provenanceDecision, {
      outcome: "unauthorized", reason: "requester_provenance_required",
    });
    await db.delete(onbCases).where(eq(onbCases.organizationId, org));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org));
  });

  test("revocation or governance withdrawal that wins the tenant fence denies a concurrent decision", async () => {
    for (const action of ["revoke", "withdraw"] as const) {
      const org = `${suffix}-${action}`;
      const specialist = `${action}-specialist`;
      const requester = `${action}-requester`;
      await createOrganization(org);
      const c = await createCase(org, requester);
      const [approval] = await db.insert(onbApprovals).values({
        organizationId: org, caseId: c.id, agent: "Concurrency fixture",
        ruleRef: "Concurrency fixture", hitlPattern: "approve-before-act",
        recommendation: "Review", rationale: "Fixture", resumeAction: "none",
        authorityScope: "hr-compliance-approve", requestedByUserId: requester,
        idempotencyKey: `${suffix}-${action}-approval`,
      }).returning();
      await db.insert(onbAuthorityGovernance).values({
        organizationId: org, status: "governance-approved", approvedByUserId: "test",
        approvedAt: new Date(), governanceSource: "test", revision: 1,
      });
      await db.insert(organizationMembershipsTable).values({
        organizationId: org, clerkUserId: specialist, role: "member",
      });
      const [assignment] = await db.insert(onbAuthorityAssignments).values({
        id: `${suffix}-${action}-authority`, organizationId: org, personUserId: specialist,
        authorityRole: "hr-compliance", scopes: ["hr-compliance-approve"],
        validFrom: new Date(Date.now() - 60_000), status: "active", revision: 1,
        grantorUserId: "test", source: "test", governanceDecisionRef: "test",
      }).returning();

      // The production revoke/withdraw paths acquire exactly this tenant fence
      // before their mutation. Hold it first so this test proves the waiting
      // decision re-reads the mutation rather than authorizing from a stale
      // assignment/governance snapshot.
      let releaseMutation!: () => void;
      const mutationMayCommit = new Promise<void>((resolve) => { releaseMutation = resolve; });
      let mutationHasFence!: () => void;
      const fenceHeld = new Promise<void>((resolve) => { mutationHasFence = resolve; });
      const mutation = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${org}))`);
        mutationHasFence();
        await mutationMayCommit;
        if (action === "revoke") {
          await tx.update(onbAuthorityAssignments).set({ status: "revoked", revision: 2 })
            .where(eq(onbAuthorityAssignments.id, assignment.id));
        } else {
          await tx.update(onbAuthorityGovernance).set({ status: "withdrawn", revision: 2 })
            .where(eq(onbAuthorityGovernance.organizationId, org));
        }
      });
      await fenceHeld;
      const decision = decideApproval({
        organizationId: org, approvalId: approval.id, expectedVersion: 1,
        decision: "approved", decidedBy: specialist, actorUserId: specialist,
      });
      releaseMutation();
      await mutation;
      const result = await decision;
      assert.equal(result.outcome, "unauthorized", `${action} wins the tenant fence`);
      if (result.outcome === "unauthorized") {
        assert.match(result.reason, action === "revoke"
          ? /no_current_verified_scoped_assignment/
          : /production_governance_approval_required/);
      }
      const [current] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval.id));
      assert.equal(current.status, "pending");
      await db.delete(onbCases).where(eq(onbCases.organizationId, org));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, org));
    }
  });
});