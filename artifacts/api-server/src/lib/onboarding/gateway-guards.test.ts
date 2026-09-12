import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbApprovals,
  onbCases,
  onbCommunications,
  onbEvents,
  onbPolicyAuthorities,
  onbReadinessSlaAttestations,
  onbSystemChecks,
} from "@workspace/db";
import { decideApproval } from "./approval-decisions";
import { verifyChecklistEvidence } from "./checklist";
import { LEGACY_CHECKLIST, readinessFromChecklist } from "./settings";
import {
  completeDay1ReadinessGate,
  DAY1_READINESS_GATE_RULE,
  offerAcceptanceRequired,
  resumeChecklistOrchestration,
} from "./engine";
import { calculateOutcomeKpis } from "./outcome-kpis";
import { ensureReadinessSlaEnrollment } from "./readiness-sla-policy";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `gateway-guards-${process.pid}-${randomUUID()}`;
const caseIds: number[] = [];

describe("three onboarding gateway guards", { skip: !hasDb }, () => {
  after(async () => {
    for (const id of caseIds) {
      await db.delete(onbCases).where(and(
        eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbCases.id, id),
      ));
    }
  });

  test("Gate A applies only to new external onboarding and rehires", () => {
    assert.equal(offerAcceptanceRequired({ hireType: "external-fte" }), true);
    assert.equal(offerAcceptanceRequired({ hireType: "contractor" }), true);
    assert.equal(offerAcceptanceRequired({ hireType: "rehire" }), true);
    assert.equal(offerAcceptanceRequired({ hireType: "internal-transfer" }), false);
  });

  test("a direct/resumed active new-hire path records the blocked email and cannot reach downstream work", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "Unconfirmed offer",
      workerEmail: `unconfirmed-${suffix}@example.com`,
      // No case-scoped candidate email authorization: this must remain a
      // blocked, email-only request rather than falling back to WhatsApp.
      channelPreference: "whatsapp",
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Test Co",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
      orchestrationStatus: "checklist-blocked",
      orchestrationCheckpoint: "initial",
      readiness: readinessFromChecklist(LEGACY_CHECKLIST),
      checklistSnapshot: LEGACY_CHECKLIST.map((item) => ({ ...item })),
    }).returning();
    caseIds.push(c.id);
    assert.equal(await resumeChecklistOrchestration(c.id), true);
    assert.equal(await resumeChecklistOrchestration(c.id), false);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, c.id));
    const communications = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbCommunications.caseId, c.id),
      eq(onbCommunications.idempotencyKey, `gateway-a:${c.id}:offer-package:email`),
    ));
    assert.equal(current.orchestrationCheckpoint, "waiting:offer-acceptance");
    assert.equal(current.lifecycleStage, "trigger-received");
    assert.equal(communications.length, 1);
    assert.equal(communications[0].channel, "email");
    assert.equal(communications[0].status, "logged-only");
  });

  async function approvedReadyCase(readiness = readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({
    ...item,
    status: "ready",
  }))) {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: `Gate test ${caseIds.length}`,
      workerEmail: `gate-${suffix}-${caseIds.length}@example.com`,
      hireType: "internal-transfer",
      workerCategory: "employee",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Test Co",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
      lifecycleStage: "day1-review",
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:day1-readiness",
      readiness,
      checklistSnapshot: LEGACY_CHECKLIST.map((item) => ({ ...item })),
    }).returning();
    caseIds.push(c.id);
    // The weighted Gate C hook is fail-closed for active un-enrolled cases.
    // Keep this legacy gateway fixture explicit: enroll the current snapshot
    // and attest the source HRIS stream while preserving the test's readiness
    // variation for the mandatory-item regression below.
    const enrollment = await ensureReadinessSlaEnrollment(DEMO_ORGANIZATION_ID, c.id, "gateway-guards-test");
    assert.ok(enrollment);
    await db.insert(onbReadinessSlaAttestations).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId: c.id,
      snapshotVersion: enrollment.state.snapshotVersion,
      streamKey: "hris",
      complete: true,
      reason: "Gateway test fixture has current HRIS completion evidence",
      attestedBy: "gateway-guards-test",
      attestedRole: "hr-owner",
    });
    await db.insert(onbSystemChecks).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId: c.id,
      system: "payroll",
      mode: "poll",
      externalRef: `gateway-payroll-${c.id}`,
      status: "done",
      dueAt: new Date("2029-01-01T00:00:00.000Z"),
      completedAt: new Date("2029-01-01T00:00:00.000Z"),
    });
    await db.insert(onbApprovals).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId: c.id,
      agent: "day1-readiness-gate",
      ruleRef: DAY1_READINESS_GATE_RULE,
      hitlPattern: "approve-before-act",
      recommendation: "Confirm",
      rationale: "Fixture",
      resumeAction: "none",
      status: "approved",
      idempotencyKey: `gateway-c:${c.id}:human-queue`,
    });
    return c.id;
  }

  test("parallel Gate C completion claims converge to one audited completion", async () => {
    const id = await approvedReadyCase();
    const [first, second] = await Promise.all([
      completeDay1ReadinessGate(id),
      completeDay1ReadinessGate(id),
    ]);
    // The case lock grants one completion claim. The loser observes the
    // terminal case and returns false rather than replaying an old approval;
    // both calls must still converge to one successful audited completion.
    assert.equal([first, second].filter(Boolean).length, 1);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, id));
    const events = await db.select().from(onbEvents).where(and(
      eq(onbEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbEvents.idempotencyKey, `gateway-c:${id}:complete:v1`),
    ));
    assert.equal(current.lifecycleStage, "complete");
    assert.equal(events.length, 1);
  });

  test("an approved generic final-review row cannot pass a reopened mandatory item", async () => {
    const readiness = readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({
      ...item,
      status: item.key === "access" ? "pending" : "ready",
    }));
    const id = await approvedReadyCase(readiness);
    assert.equal(await completeDay1ReadinessGate(id), false);
    const [current] = await db.select().from(onbCases).where(eq(onbCases.id, id));
    assert.equal(current.lifecycleStage, "preboarding");
    assert.equal(current.orchestrationCheckpoint, "blocked:re-review");
    const [approval] = await db.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbApprovals.caseId, id),
      eq(onbApprovals.idempotencyKey, `gateway-c:${id}:human-queue`),
    ));
    assert.equal(approval.status, "pending");
  });

  test("only a fresh Gate C cycle can restore a rejected-evidence outcome cohort", async () => {
    const id = await approvedReadyCase();
    assert.equal(await completeDay1ReadinessGate(id), true);

    const evidenceGate = {
      id: "fresh-safety-evidence",
      label: "Fresh safety evidence",
      order: 99,
      enabled: true,
      mandatory: true,
      evidenceRequired: true,
      enforcementStage: "before-workstreams" as const,
      responsibleRole: "hse",
      completionAuthority: "designated-human" as const,
    };
    const acceptanceAt = new Date(Date.now() - 60_000);
    await db.update(onbCases).set({
      offerAcceptanceComplete: true,
      offerAcceptanceCompletedAt: acceptanceAt,
      workforceContext: {
        workEnvironment: "site",
        site: "yard",
        siteExposure: true,
        safetyCritical: true,
      },
      checklistSnapshot: [...LEGACY_CHECKLIST, evidenceGate],
      readiness: [
        ...readinessFromChecklist(LEGACY_CHECKLIST).map((item) => ({ ...item, status: "ready" as const })),
        { key: evidenceGate.id, label: evidenceGate.label, status: "ready" as const },
      ],
    }).where(eq(onbCases.id, id));
    await db.insert(onbPolicyAuthorities).values({
      organizationId: DEMO_ORGANIZATION_ID,
      userId: "fresh-hse-reviewer",
      authorityRole: "hse",
      caseId: id,
      itemId: evidenceGate.id,
      site: "yard",
      assignedBy: "gateway-guards-test",
    });
    const expected = {
      contextVersion: 1,
      templateVersion: 1,
      profileId: "default",
      profileVersion: 1,
    };
    const rejected = await verifyChecklistEvidence({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId: id,
      itemId: evidenceGate.id,
      evidenceReference: "superseded-source",
      authorityRole: "hse",
      decision: "rejected",
      reason: "The prior source is no longer current.",
      verifier: "HSE reviewer",
      verifierUserId: "fresh-hse-reviewer",
      expected,
    });
    assert.equal(rejected.ok, true);

    const [reopenedApproval] = await db.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbApprovals.caseId, id),
      eq(onbApprovals.idempotencyKey, `gateway-c:${id}:human-queue`),
    ));
    assert.equal(reopenedApproval.status, "pending");
    assert.equal(reopenedApproval.version, 2);
    const reopenEvents = await db.select().from(onbEvents).where(and(
      eq(onbEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbEvents.idempotencyKey, `gateway-c:${id}:reopened:v2`),
    ));
    assert.equal(reopenEvents.length, 1);
    assert.equal(reopenEvents[0].agent, "day1-readiness-gate");
    assert.equal(reopenEvents[0].title, "Gate C approval invalidated by changed live readiness evidence");

    assert.equal((await verifyChecklistEvidence({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId: id,
      itemId: evidenceGate.id,
      evidenceReference: "replacement-source",
      authorityRole: "hse",
      decision: "verified",
      reason: "A current replacement source was reviewed.",
      verifier: "HSE reviewer",
      verifierUserId: "fresh-hse-reviewer",
      expected,
    })).ok, true);
    assert.equal((await decideApproval({
      organizationId: DEMO_ORGANIZATION_ID,
      approvalId: reopenedApproval.id,
      expectedVersion: 1,
      decision: "approved",
      decidedBy: "hr-original",
      comment: "Old approval response",
    })).outcome, "stale");

    const beforeFreshDecision = await db.select().from(onbCases).where(eq(onbCases.id, id));
    const beforeFreshEvents = await db.select().from(onbEvents).where(eq(onbEvents.caseId, id));
    const beforeFreshKpis = calculateOutcomeKpis({
      cases: [{
        ...beforeFreshDecision[0],
        hireType: "external-fte",
        gateCApprovalStatus: "pending",
      }],
      events: beforeFreshEvents,
      asOf: new Date(Date.now() + 60_000),
      period: "All",
    });
    assert.equal(beforeFreshKpis.metrics.find((metric) => metric.id === "cycle-time")?.sampleSize, 0);

    const freshDecision = await decideApproval({
      organizationId: DEMO_ORGANIZATION_ID,
      approvalId: reopenedApproval.id,
      expectedVersion: 2,
      decision: "approved",
      decidedBy: "hr-fresh",
      comment: "Fresh final review after replacement evidence",
    });
    assert.equal(freshDecision.outcome, "decided");
    // decideApproval starts its continuation after commit; this direct retry
    // shares the Gate C lock and is harmless if that continuation wins first.
    await completeDay1ReadinessGate(id);
    const [completedCase] = await db.select().from(onbCases).where(eq(onbCases.id, id));
    const [completedApproval] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, reopenedApproval.id));
    assert.equal(completedCase.lifecycleStage, "complete");
    assert.equal(completedApproval.status, "approved");
    assert.equal(completedApproval.version, 2);
    const completions = await db.select().from(onbEvents).where(and(
      eq(onbEvents.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbEvents.caseId, id),
      eq(onbEvents.idempotencyKey, `gateway-c:${id}:complete:v2`),
    ));
    assert.equal(completions.length, 1);
    assert.ok(completions[0].createdAt instanceof Date);

    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, id));
    const freshKpis = calculateOutcomeKpis({
      cases: [{
        ...completedCase,
        // The fixture's enrollment intentionally uses the transfer stream
        // applicability. The measurement assertion verifies that a qualifying
        // new-hire cohort sees only the post-reopen confirmation event.
        hireType: "external-fte",
        gateCApprovalStatus: completedApproval.status,
      }],
      events,
      asOf: new Date(Date.now() + 60_000),
      period: "All",
    });
    assert.equal(freshKpis.metrics.find((metric) => metric.id === "cycle-time")?.sampleSize, 1);
  });
});