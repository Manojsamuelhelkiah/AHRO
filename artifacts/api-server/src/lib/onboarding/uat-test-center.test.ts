import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import {
  accessNamedGrants, db, onbAuthorityAssignments, onbAuthorityGovernance, onbCandidateLinks, onbCases,
  onbGovernanceDecisionReviews, onbGovernanceDecisions, onbGovernanceDispatchMarkers, onbGovernanceHistory,
  onbGovernanceReminders, onbGovernanceRequirements, onbSettings, organizationMembershipsTable, organizationsTable,
} from "@workspace/db";
import { applyUatAction, createUatRun, getUatRun } from "./uat-test-center";
import { isSyntheticOfflineCase, isUatRunIsolatedCase } from "./synthetic-offline";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `uat-center-${process.pid}-${randomUUID()}`;
const organizationId = `${suffix}-a`;
const otherOrganizationId = `${suffix}-b`;
const actor = `${suffix}-actor`;
const unauthorizedActor = `${suffix}-unauthorized`;

async function grantUatCaseAccess(caseId: number) {
  const resourceKeys = [
    "data.case.profile.read",
    "data.case.profile.edit",
    "data.case.notes.read",
    "data.case.notes.edit",
    "flow.case.read",
    "flow.case.edit",
    "data.identity.read",
    "data.identity.edit",
    "data.medical.read",
    "data.medical.edit",
    "data.payroll.read",
    "data.payroll.edit",
    "data.bgv.read",
    "data.bgv.edit",
  ];
  await db.insert(accessNamedGrants).values(resourceKeys.map((resourceKey) => ({
    organizationId,
    principalType: "human" as const,
    principalId: actor,
    scope: "case" as const,
    caseId,
    resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
    resourceKey,
    source: "named" as const,
    effect: "allow" as const,
    requiresApproval: "yes" as const,
    createdByUserId: actor,
    approvedByUserId: `${suffix}-independent-approver`,
    approvedAt: new Date(),
  })));
}

describe("UAT Test Center durable isolation", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(organizationsTable).values([
      { id: organizationId, name: organizationId, slug: organizationId, joinCodeHash: `${suffix}-a`, createdByUserId: actor },
      { id: otherOrganizationId, name: otherOrganizationId, slug: otherOrganizationId, joinCodeHash: `${suffix}-b`, createdByUserId: actor },
    ]);
    await db.insert(organizationMembershipsTable).values({ organizationId, clerkUserId: actor, role: "admin" });
    await db.insert(onbAuthorityGovernance).values({
      organizationId, status: "governance-approved", operatorUserId: actor, approvedByUserId: actor,
      attestationNote: "Test-only controlled authority fixture", governanceSource: "test-fixture",
    });
    await db.insert(onbAuthorityAssignments).values([
      {
        id: `${suffix}-hr`, organizationId, personUserId: actor, authorityRole: "hr-compliance",
        scopes: ["hr-compliance-approve"], grantorUserId: actor, source: "test-fixture", governanceDecisionRef: "test-authority",
      },
      {
        id: `${suffix}-oh`, organizationId, personUserId: actor, authorityRole: "occupational-health",
        scopes: ["occupational-health-approve"], grantorUserId: actor, source: "test-fixture", governanceDecisionRef: "test-authority",
      },
      {
        id: `${suffix}-payroll`, organizationId, personUserId: actor, authorityRole: "payroll",
        scopes: ["payroll-approve"], grantorUserId: actor, source: "test-fixture", governanceDecisionRef: "test-authority",
      },
    ]);
  });
  after(async () => {
    await db.delete(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), like(onbSettings.key, "onboarding-uat.run.v1:%")));
    await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
    await db.delete(onbGovernanceDecisionReviews).where(eq(onbGovernanceDecisionReviews.organizationId, organizationId));
    await db.delete(onbGovernanceHistory).where(eq(onbGovernanceHistory.organizationId, organizationId));
    await db.delete(onbGovernanceReminders).where(eq(onbGovernanceReminders.organizationId, organizationId));
    await db.delete(onbGovernanceDispatchMarkers).where(eq(onbGovernanceDispatchMarkers.organizationId, organizationId));
    await db.delete(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, organizationId));
    await db.delete(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  });

  test("create request is durable/idempotent and case is dispatch-offline", async () => {
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId }),
      createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId }),
    ]);
    assert.equal(first.runId, second.runId);
    assert.equal(first.linkedCaseIds.length, 1);
    assert.equal(first.syntheticProfile.workerName, "Avery Example");
    assert.match(first.syntheticProfile.workerEmail, /@example\.invalid$/);
    assert.equal(first.syntheticProfile.fictional, true);
    assert.equal(first.initialization, "ready");
    const [caseRow] = await db.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, first.linkedCaseIds[0]!)));
    assert.ok(caseRow);
    assert.equal(isSyntheticOfflineCase(caseRow), true);
    assert.equal(isUatRunIsolatedCase(caseRow), true);
    assert.equal(await getUatRun(otherOrganizationId, first.runId), null);
  });

  test("same action request is one durable effect and due events use run clock", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId: randomUUID() });
    const requestId = randomUUID();
    const action = { expectedVersion: run.version, requestId, kind: "exchange" as const, system: "hris" as const, operation: "request" as const, state: "queued", eventKey: `${suffix}-event` };
    const [first, duplicate] = await Promise.all([
      applyUatAction(organizationId, actor, run.runId, action),
      applyUatAction(organizationId, actor, run.runId, action),
    ]);
    assert.equal(first.version, duplicate.version);
    const sequentialRetry = await applyUatAction(organizationId, actor, run.runId, action);
    assert.equal(sequentialRetry.version, first.version);
    assert.equal(first.pendingEvents.filter((event) => event.state === "pending").length, 1);
    const advanced = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: first.version, requestId: randomUUID(), kind: "advance-clock", hours: 1,
    });
    assert.equal(advanced.pendingEvents[0]?.state, "applied");
    assert.equal(advanced.exchanges.some((event) => event.state === "simulated-response"), true);
    const lateReplay = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: advanced.version, requestId: randomUUID(), kind: "exchange",
      system: "hris", operation: "webhook", state: "late-complete", eventKey: `${suffix}-event`,
    });
    assert.equal(lateReplay.pendingEvents.some((event) => event.state === "ignored-duplicate"), true);
    await assert.rejects(
      applyUatAction(otherOrganizationId, actor, run.runId, {
        expectedVersion: 0, requestId: randomUUID(), kind: "pause",
      }),
      { name: "UatRunNotFound" },
    );
  });

  test("cleanup is terminal and cancels queued run-only effects", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId: randomUUID() });
    const queued = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: run.version, requestId: randomUUID(), kind: "exchange",
      system: "itsm", operation: "request", state: "queued", eventKey: `${suffix}-cleanup-event`,
    });
    const cleaned = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: queued.version, requestId: randomUUID(), kind: "cleanup",
    });
    assert.equal(cleaned.status, "cleaned");
    assert.equal(cleaned.pendingEvents[0]?.state, "blocked");
    await assert.rejects(applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: cleaned.version, requestId: randomUUID(), kind: "resume",
    }), { name: "UatRunCleaned" });
    await assert.rejects(applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: cleaned.version, requestId: randomUUID(), kind: "exchange",
      system: "itsm", operation: "webhook", state: "late",
    }), { name: "UatRunCleaned" });
  });

  test("accepts all eight explicitly harmless fixture scanner facts and evaluates structured assertions", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-DOC-01", requestId: randomUUID() });
    let current = run;
    for (const fixtureId of ["valid", "missing-information", "expired", "inconsistent-name", "unsupported-format", "oversized", "corrupt", "changed-bytes"]) {
      current = await applyUatAction(organizationId, actor, run.runId, {
        expectedVersion: current.version, requestId: randomUUID(), kind: "inject-harmless-scanner-fact",
        fixtureId, scannerState: "clean",
      });
    }
    const evaluated = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: current.version, requestId: randomUUID(), kind: "evaluate-workflow",
    });
    assert.equal(evaluated.scannerFacts.length, 8);
    assert.ok(evaluated.workflowEvaluation);
    assert.equal(evaluated.workflowEvaluation!.decisions.some((decision) => decision.id === "documents"), true);
  });

  test("recovers an interrupted prepared effect without resending and then permits cleanup", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId: randomUUID() });
    const requestId = randomUUID();
    const action = { expectedVersion: 0, requestId, kind: "dispatch-approved-demo-email" as const };
    const hash = createHash("sha256").update(JSON.stringify({ ...action, publicBase: undefined })).digest("hex");
    const [stored] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId), like(onbSettings.key, `onboarding-uat.run.v1:${run.runId}`),
    ));
    assert.ok(stored);
    const interrupted = JSON.parse(stored.value);
    interrupted.actions[requestId] = `pending:${hash}`;
    interrupted.externalEffects[requestId] = {
      kind: "dispatch-approved-demo-email", state: "prepared", intentHash: hash, bodyHash: hash,
      preparedAt: interrupted.clock.now, preparedBy: actor, prevalidation: "test", correlationId: null,
    };
    await db.update(onbSettings).set({ value: JSON.stringify(interrupted) }).where(and(
      eq(onbSettings.organizationId, organizationId), like(onbSettings.key, `onboarding-uat.run.v1:${run.runId}`),
    ));
    const recovered = await applyUatAction(organizationId, actor, run.runId, action);
    assert.equal(recovered.externalActionStatus?.state, "uncertain");
    const cleaned = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: recovered.version, requestId: randomUUID(), kind: "cleanup",
    });
    assert.equal(cleaned.status, "cleaned");
  });

  test("issues a no-email credential through the real authorized local UAT boundary", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId: randomUUID() });
    await grantUatCaseAccess(run.linkedCaseIds[0]!);
    const issued = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: run.version, requestId: randomUUID(), kind: "issue-candidate-portal",
    }, { publicBase: "https://uat.invalid" });
    assert.equal(issued.externalActionStatus?.state, "confirmed", issued.externalActionStatus?.message);
    // Bearer material exists only at this explicit action boundary; never log it.
    assert.match((issued as typeof issued & { candidatePortal?: { launchUrl?: string } }).candidatePortal?.launchUrl ?? "", /^https:\/\/uat\.invalid\/candidate#token=/);
    const [link] = await db.select({ id: onbCandidateLinks.id }).from(onbCandidateLinks).where(and(
      eq(onbCandidateLinks.organizationId, organizationId),
      eq(onbCandidateLinks.caseId, run.linkedCaseIds[0]!),
    ));
    assert.ok(link);
    const paused = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: issued.version, requestId: randomUUID(), kind: "pause",
    });
    const cleaned = await applyUatAction(organizationId, actor, run.runId, {
      expectedVersion: paused.version, requestId: randomUUID(), kind: "cleanup",
    });
    assert.equal(cleaned.status, "cleaned");
    const [revoked] = await db.select({ revokedAt: onbCandidateLinks.revokedAt }).from(onbCandidateLinks).where(and(
      eq(onbCandidateLinks.organizationId, organizationId), eq(onbCandidateLinks.id, link.id),
    ));
    assert.ok(revoked?.revokedAt);
  });

  test("denies the same real portal boundary to an actor without authority", async () => {
    const run = await createUatRun(organizationId, actor, { scenarioId: "UAT-STD-01", requestId: randomUUID() });
    const denied = await applyUatAction(organizationId, unauthorizedActor, run.runId, {
      expectedVersion: run.version, requestId: randomUUID(), kind: "issue-candidate-portal",
    }, { publicBase: "https://uat.invalid" });
    assert.equal(denied.externalActionStatus?.state, "terminal-failure");
    assert.match(denied.externalActionStatus?.message ?? "", /^SENSITIVE_RECORD_ACCESS_REQUIRED:/);
  });
});