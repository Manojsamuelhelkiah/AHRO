import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { onbSettings } from "@workspace/db/schema";
import { ensureEffectJournalEntry } from "./effect-journal";
import { onbCases, onbCommunications, onbEffectJournal, onbGovernanceAuthorityAssignments, onbGovernanceDecisionReviews, onbGovernanceDecisions, onbGovernanceDispatchMarkers, onbGovernanceRequirements, onbSensitiveLifecyclePolicies, organizationsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { retryCandidateEmail, sendOutbound, setOnboardingConnectorProxyForTests } from "./channels";
import { requestOfferPackageEmail, startOrchestration } from "./engine";
import { SYNTHETIC_OFFLINE_MARKER, isSyntheticOfflineCase } from "./synthetic-offline";
import { runWithProviderDeny } from "./provider-policy";
import { UAT_RUN_SETTING_PREFIX } from "./uat-isolation";
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
    await db.delete(onbSettings).where(eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID));
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
      workerEmail: "retry-claim@fake-provider.mailhost.com",
      channelPreference: "whatsapp",
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
      workerEmail: "retry-capped@fake-provider.mailhost.com",
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
    const email = "retry-volunteer@fake-provider.mailhost.com";
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

  async function emailCase(patch: Partial<typeof onbCases.$inferInsert> = {}) {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Default Email Fixture__", workerEmail: "default@fake-provider.mailhost.com",
      channelPreference: "whatsapp", candidateEmailAuthorizedAt: null,
      hireType: "external-fte", workerCategory: "employee", role: "QA", department: "QA",
      geography: "US", legalEntity: "TestCo", managerName: "Manager", recruiterName: "Recruiter",
      joiningDate: "2026-09-01", workforceContext: { workCountry: "US" },
      processPolicySnapshot: withGovernanceDecisionSnapshot({}, governanceSnapshot),
      orchestrationStatus: "blocked",
      ...patch,
    }).returning();
    caseIds.push(c.id);
    return c;
  }

  test("new, legacy and imported case envelopes send default email once without authorization or WhatsApp effects", async () => {
    let calls = 0;
    setOnboardingConnectorProxyForTests(async (_connector, _path, opts) => {
      calls++;
      const raw = JSON.parse(String(opts?.body)).raw;
      assert.match(Buffer.from(raw, "base64url").toString(), /To: default@fake-provider.mailhost.com/);
      return new Response(JSON.stringify({ id: `fake-${calls}` }), { status: 200 });
    });
    try {
      for (const patch of [
        { channelPreference: "email" },
        { channelPreference: "both", createdAt: new Date("2020-01-01") },
        { channelPreference: "whatsapp", orchestrationStatus: "batch-intake-pending-review" },
        { channelPreference: "email", orchestrationStatus: "hro-request-pending-review" },
      ]) {
        const c = await emailCase(patch);
        const before = calls;
        const first = await requestOfferPackageEmail(c.id);
        const second = await requestOfferPackageEmail(c.id);
        assert.equal(first.status, "sent");
        assert.equal(second.id, first.id);
        assert.equal(calls, before + 1);
        const [current] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
        assert.equal(current.offerAcceptanceComplete, false);
        assert.equal(current.orchestrationStatus, c.orchestrationStatus);
        const messages = await db.select().from(onbCommunications).where(eq(onbCommunications.caseId, c.id));
        assert.equal(messages.length, 1);
        assert.equal(messages[0].channel, "email");
      }
    } finally { setOnboardingConnectorProxyForTests(null); }
  });

  test("supplied deliverable sample emails acquire durable guards but never activate sample workflows", async () => {
    let calls = 0;
    setOnboardingConnectorProxyForTests(async () => {
      calls++;
      return new Response(JSON.stringify({ id: `sample-fake-${calls}` }), { status: 200 });
    });
    try {
      for (const syntheticProvenance of ["synthetic-reset", "onboarding-demo-fictional", "demo-full-coverage"] as const) {
        const c = await emailCase({
          syntheticProvenance, notes: SYNTHETIC_OFFLINE_MARKER,
          scenarioKey: syntheticProvenance === "demo-full-coverage" ? "UAT-DEMO-COVERAGE:standard-fte" : null,
        });
        assert.equal(isSyntheticOfflineCase(c), true);
        assert.equal((await requestOfferPackageEmail(c.id)).status, "sent");
        startOrchestration(c.id);
        const whatsapp = await sendOutbound({ caseId: c.id, channel: "whatsapp", toAddress: "+15550001111", body: "No live WhatsApp" });
        assert.equal(whatsapp.status, "blocked");
        const [current] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
        assert.equal(current.offerAcceptanceComplete, false);
        assert.equal(current.orchestrationStatus, "blocked");
        const effects = await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id));
        assert.ok(effects.some((effect) => effect.toolName === "provider-dispatch-guard"));
        assert.ok(effects.every((effect) => ["provider-dispatch-guard", "send-email"].includes(effect.toolName)));
      }
      assert.equal(calls, 3);
    } finally { setOnboardingConnectorProxyForTests(null); }
  });

  test("reserved, invalid, missing, UAT and deny-fenced recipients never reach even a fake provider", async () => {
    let calls = 0;
    setOnboardingConnectorProxyForTests(async () => { calls++; throw new Error("Must not call provider"); });
    try {
      for (const workerEmail of ["", "invalid", "a@example.com", "a@hro.invalid", "a@mail.test"]) {
        const c = await emailCase({ workerEmail });
        assert.notEqual((await requestOfferPackageEmail(c.id)).status, "sent");
      }
      const uat = await emailCase({ scenarioKey: "UAT-DEFAULT-EMAIL" });
      assert.equal((await requestOfferPackageEmail(uat.id)).status, "blocked");
      const linked = await emailCase({
        scenarioKey: "UAT-DEMO-COVERAGE:looks-like-sample",
        syntheticProvenance: "demo-full-coverage", notes: SYNTHETIC_OFFLINE_MARKER,
      });
      await db.insert(onbSettings).values({
        organizationId: linked.organizationId, key: `${UAT_RUN_SETTING_PREFIX}default-email-isolation`,
        value: JSON.stringify({ runId: "default-email-isolation", linkedCaseIds: [linked.id] }),
      });
      assert.equal((await requestOfferPackageEmail(linked.id)).status, "blocked");
      await assert.rejects(() => ensureEffectJournalEntry({
        organizationId: linked.organizationId, tenantId: linked.organizationId, caseId: linked.id,
        logicalOperationKey: `candidate-communication:linked-uat-${linked.id}`,
        toolName: "send-email", argumentsHash: "fake-hash", providerIdempotency: false,
      }), /UAT-isolated/);
      const c = await emailCase();
      const denied = await runWithProviderDeny(() => requestOfferPackageEmail(c.id));
      assert.notEqual(denied.status, "sent");
      assert.match(denied.failureReason!, /safety policy/);
      assert.equal(calls, 0);
    } finally { setOnboardingConnectorProxyForTests(null); }
  });

  test("historical blocked messages never automatically send after eligibility changes", async () => {
    const c = await emailCase({ createdAt: new Date("2020-01-01") });
    const [stored] = await db.insert(onbCommunications).values({
      organizationId: c.organizationId, caseId: c.id, channel: "email", direction: "outbound",
      audience: "candidate", toAddress: "masked@fake-provider.mailhost.com",
      body: "Frozen historical request", subject: "Offer package", status: "logged-only",
      failureReason: "Candidate email is not authorized for live delivery on this case — message logged, not delivered.",
      idempotencyKey: `gateway-a:${c.id}:offer-package:email`,
    }).returning();
    let calls = 0;
    setOnboardingConnectorProxyForTests(async () => { calls++; throw new Error("No automatic send"); });
    try {
      for (let i = 0; i < 2; i++) {
        const existing = await requestOfferPackageEmail(c.id);
        assert.equal(existing.id, stored.id);
        assert.equal(existing.status, "logged-only");
      }
      assert.equal(calls, 0);
      const orphanKey = `orphan-email:${c.id}`;
      const [orphan] = await db.insert(onbCommunications).values({
        organizationId: c.organizationId, caseId: c.id, channel: "email", direction: "outbound",
        audience: "candidate", toAddress: "masked@fake-provider.mailhost.com",
        body: "Unjournaled historical uncertainty", status: "sending", idempotencyKey: orphanKey,
      }).returning();
      const uncertain = await sendOutbound({
        caseId: c.id, channel: "email", toAddress: c.workerEmail, body: orphan.body, idempotencyKey: orphanKey,
      });
      assert.equal(uncertain.id, orphan.id);
      assert.equal(uncertain.status, "sending");
      assert.equal(calls, 0);
      const result = await retryCandidateEmail(c.id, stored.id, "reviewer", async (_to, _subject, body) => {
        calls++;
        assert.equal(body, stored.body);
        return { status: "sent", failureReason: null, externalMessageId: "manual-fake" };
      });
      assert.equal(result.ok, true);
      assert.equal(calls, 1);
      const existing = await requestOfferPackageEmail(c.id);
      assert.equal(existing.status, "sent");
      assert.equal(calls, 1);
    } finally { setOnboardingConnectorProxyForTests(null); }
  });

  test("an ambiguous journal cannot be made retryable by a stale blocked timeline row", async () => {
    const c = await emailCase();
    const key = `ambiguous-email:${c.id}`;
    const identity = {
      organizationId: c.organizationId, tenantId: c.organizationId, caseId: c.id,
      toolName: "send-email", logicalOperationKey: `candidate-communication:${key}`,
      argumentsHash: "unknown-fake-hash", providerIdempotency: false,
    };
    await ensureEffectJournalEntry(identity);
    await db.update(onbEffectJournal).set({ status: "unknown_effect_manual_repair" }).where(and(
      eq(onbEffectJournal.organizationId, c.organizationId), eq(onbEffectJournal.logicalOperationKey, identity.logicalOperationKey),
    ));
    const [message] = await db.insert(onbCommunications).values({
      organizationId: c.organizationId, caseId: c.id, channel: "email", direction: "outbound",
      audience: "candidate", toAddress: "masked@fake-provider.mailhost.com",
      body: "Uncertain prior send", status: "blocked", idempotencyKey: key,
    }).returning();
    let calls = 0;
    const result = await retryCandidateEmail(c.id, message.id, "reviewer", async () => {
      calls++; return { status: "sent", failureReason: null, externalMessageId: "must-not-send" };
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  });

  test("manual blocked retries use the current address; ambiguity and wrong-case requests cannot send", async () => {
    const c = await emailCase({ syntheticProvenance: "synthetic-reset", notes: SYNTHETIC_OFFLINE_MARKER });
    const other = await emailCase();
    const [message] = await db.insert(onbCommunications).values({
      organizationId: c.organizationId, caseId: c.id, channel: "email", direction: "outbound",
      audience: "candidate", body: "Stored blocked email", subject: "Offer package", status: "blocked",
      toAddress: "de***@fake-provider.mailhost.com",
      failureReason: "Candidate email is not authorized for live delivery on this case — message logged, not delivered.",
    }).returning();
    let calls = 0;
    const fake = async (to: string) => {
      calls++;
      assert.equal(to, c.workerEmail);
      return { status: "sending", failureReason: "Delivery outcome unknown", externalMessageId: null };
    };
    assert.equal((await retryCandidateEmail(other.id, message.id, "reviewer", fake)).ok, false);
    const first = await retryCandidateEmail(c.id, message.id, "reviewer", fake);
    assert.equal(first.ok, true);
    assert.equal((await retryCandidateEmail(c.id, message.id, "reviewer", fake)).ok, false);
    assert.equal(calls, 1);
    // This fixture intentionally leaves ambiguity. Remove only its test-owned
    // organization markers so later independent fixtures are not blocked.
    await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, c.organizationId));
  });

  test("privacy withdrawal and current governance denial block default candidate email", async () => {
    const c = await emailCase();
    let calls = 0;
    setOnboardingConnectorProxyForTests(async () => { calls++; throw new Error("Must not call"); });
    try {
      await db.update(onbSensitiveLifecyclePolicies).set({ providerSharingApproved: false }).where(and(
        eq(onbSensitiveLifecyclePolicies.organizationId, c.organizationId),
        eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-contact"),
      ));
      const denied = await requestOfferPackageEmail(c.id);
      assert.notEqual(denied.status, "sent");
      await db.update(onbSensitiveLifecyclePolicies).set({ providerSharingApproved: true }).where(and(
        eq(onbSensitiveLifecyclePolicies.organizationId, c.organizationId),
        eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-contact"),
      ));
      await db.update(onbGovernanceDecisions).set({ status: "rejected" })
        .where(eq(onbGovernanceDecisions.organizationId, c.organizationId));
      const governed = await requestOfferPackageEmail((await emailCase()).id);
      assert.equal(governed.status, "blocked");
      assert.match(governed.failureReason!, /governance/i);
      assert.equal(calls, 0);
    } finally {
      await db.update(onbSensitiveLifecyclePolicies).set({ providerSharingApproved: true }).where(and(
        eq(onbSensitiveLifecyclePolicies.organizationId, c.organizationId),
        eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-contact"),
      ));
      await db.update(onbGovernanceDecisions).set({ status: "approved" })
        .where(eq(onbGovernanceDecisions.organizationId, c.organizationId));
      await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, c.organizationId));
      setOnboardingConnectorProxyForTests(null);
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