import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbApprovals, onbCases, onbCommunications, onbEffectJournal, onbEvents } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { addCandidateReplyReference, sendOutbound } from "./channels";
import { createApproval, defaultReadiness, reconcileDecidedApprovals } from "./engine";
import { checklistStageBlockers } from "./settings";
import {
  claimEffectDispatch,
  confirmEffect,
  markAmbiguousEffectForManualRepair,
  sweepExpiredNonIdempotentEffects,
} from "./effect-journal";

const hasDb = Boolean(process.env.DATABASE_URL);
const keys: string[] = [];
const caseIds: number[] = [];
const identity = (caseId: number, suffix: string, providerIdempotency = false) => {
  const logicalOperationKey = `effect-journal-test:${Date.now()}:${suffix}`;
  keys.push(logicalOperationKey);
  return {
    logicalOperationKey,
    organizationId: DEMO_ORGANIZATION_ID,
    tenantId: "test-tenant",
    caseId,
    toolName: "update-payroll",
    argumentsHash: `sha256:${suffix}`,
    providerIdempotency,
  };
};

describe("durable connector effect journal (real DB)", { skip: !hasDb }, () => {
  after(async () => {
    for (const key of keys) {
      await db.delete(onbEffectJournal).where(eq(onbEffectJournal.logicalOperationKey, key));
    }
    for (const caseId of caseIds) {
      await db.delete(onbCases).where(eq(onbCases.id, caseId));
    }
  });

  async function createCase() {
    const [created] = await db
      .insert(onbCases)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        workerName: "Effect Journal Test",
        workerEmail: `effect-${Date.now()}-${caseIds.length}@example.com`,
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Engineer",
        department: "R&D",
        geography: "US",
        legalEntity: "Test Co",
        managerName: "Manager",
        recruiterName: "Recruiter",
        joiningDate: "2026-09-08",
      })
      .returning({ id: onbCases.id });
    caseIds.push(created.id);
    return created.id;
  }

  test("concurrent claims create one row and exactly one owner advances the token", async () => {
    const operation = identity(await createCase(), "concurrent");
    const [a, b] = await Promise.all([
      claimEffectDispatch({ ...operation, owner: "worker-a", expectedFencingToken: 0 }),
      claimEffectDispatch({ ...operation, owner: "worker-b", expectedFencingToken: 0 }),
    ]);
    assert.equal([a, b].filter((r) => r.kind === "claimed").length, 1);
    const rows = await db
      .select()
      .from(onbEffectJournal)
      .where(eq(onbEffectJournal.logicalOperationKey, operation.logicalOperationKey));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fencingToken, 1);
  });

  test("concurrent non-idempotent dispatchers invoke the provider at most once", async () => {
    const operation = identity(await createCase(), "single-provider-call");
    let providerCalls = 0;
    const dispatch = async (owner: string) => {
      const claim = await claimEffectDispatch({
        ...operation,
        owner,
        expectedFencingToken: 0,
      });
      if (claim.kind !== "claimed") return claim.kind;
      providerCalls += 1;
      await confirmEffect({
        logicalOperationKey: operation.logicalOperationKey,
        organizationId: operation.organizationId,
        owner,
        fencingToken: claim.fencingToken,
        externalEffectId: "provider-message",
      });
      return "dispatched";
    };
    await Promise.all([dispatch("sender-a"), dispatch("sender-b")]);
    assert.equal(providerCalls, 1);
  });

  test("welcome retries reuse the first durably persisted payload", async () => {
    const caseId = await createCase();
    const key = `payload-source-${Date.now()}`;
    const logicalKey = `candidate-communication:${key}`;
    keys.push(logicalKey);
    const firstBody = addCandidateReplyReference("First generated welcome");
    const secondBody = addCandidateReplyReference("Different regenerated LLM welcome");
    const [firstReference] = firstBody.match(/CR-[a-f0-9]{32}/g) ?? [];
    const [secondReference] = secondBody.match(/CR-[a-f0-9]{32}/g) ?? [];
    assert.ok(firstReference);
    assert.ok(secondReference);
    assert.notEqual(secondReference, firstReference);
    const first = await sendOutbound({
      caseId,
      channel: "email",
      toAddress: "never-deliver@example.invalid",
      subject: "Frozen subject",
      body: firstBody,
      idempotencyKey: key,
    });
    const second = await sendOutbound({
      caseId,
      channel: "email",
      toAddress: "never-deliver@example.invalid",
      subject: "Different retry subject",
      body: secondBody,
      idempotencyKey: key,
    });
    assert.equal(second.id, first.id);
    const rows = await db.select().from(onbCommunications).where(and(
      eq(onbCommunications.caseId, caseId),
      eq(onbCommunications.idempotencyKey, key),
    ));
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /First generated welcome/);
    assert.doesNotMatch(rows[0].body, /Different regenerated/);
    assert.match(rows[0].body, new RegExp(firstReference));
    assert.doesNotMatch(rows[0].body, new RegExp(secondReference));
    assert.equal(rows[0].subject, "Frozen subject");
    await db.delete(onbCommunications).where(eq(onbCommunications.id, first.id));
  });

  test("replayed intake approval creates one approval and one timeline event", async () => {
    const caseId = await createCase();
    const key = `approval-replay-${Date.now()}`;
    const request = {
      caseId,
      agent: "intake",
      ruleRef: "4.1 Intake Rule 2",
      hitlPattern: "approve-before-act" as const,
      recommendation: "Approve expedited onboarding",
      rationale: "Short lead time",
      resumeAction: "continue-after-intake",
      idempotencyKey: key,
    };
    await createApproval(request);
    await createApproval(request);
    const approvals = await db.select().from(onbApprovals).where(and(
      eq(onbApprovals.caseId, caseId),
      eq(onbApprovals.idempotencyKey, key),
    ));
    const events = await db.select().from(onbEvents).where(and(
      eq(onbEvents.caseId, caseId),
      eq(onbEvents.idempotencyKey, `${key}:event`),
    ));
    assert.equal(approvals.length, 1);
    assert.equal(events.length, 1);
    await db.delete(onbEvents).where(eq(onbEvents.caseId, caseId));
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("an approval decided before waiting is reconciled exactly once as intake-approved", async () => {
    const caseId = await createCase();
    await db.update(onbCases).set({
      readiness: defaultReadiness(),
      orchestrationStatus: "running",
      orchestrationCheckpoint: "initial",
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbApprovals).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId,
      agent: "intake",
      ruleRef: "test-intake",
      hitlPattern: "approve-before-act",
      recommendation: "Proceed",
      rationale: "Approved early",
      resumeAction: "continue-after-intake",
      status: "approved",
    });
    let continuations = 0;
    const continuation = async (_id: number, planApproved: boolean) => {
      continuations += 1;
      assert.equal(planApproved, false);
    };
    assert.equal(await reconcileDecidedApprovals(caseId, continuation), false);
    await db.update(onbCases).set({
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:intake",
    }).where(eq(onbCases.id, caseId));
    await Promise.all([
      reconcileDecidedApprovals(caseId, continuation),
      reconcileDecidedApprovals(caseId, continuation),
    ]);
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(continuations, 1);
    assert.equal(c.orchestrationCheckpoint, "intake-approved");
    assert.equal(c.readiness.find((item) => item.key === "profile")?.status, "ready");
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("a decided plan approval is recovered after interruption without bypass confusion", async () => {
    const caseId = await createCase();
    await db.update(onbCases).set({
      readiness: defaultReadiness(),
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:plan",
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbApprovals).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId,
      agent: "plan",
      ruleRef: "test-plan",
      hitlPattern: "approve-before-act",
      recommendation: "Apply finance gate",
      rationale: "Approved before process interruption",
      resumeAction: "continue-after-plan",
      status: "approved",
    });
    let continuations = 0;
    await reconcileDecidedApprovals(caseId, async (_id, planApproved) => {
      continuations += 1;
      assert.equal(planApproved, true);
    });
    await reconcileDecidedApprovals(caseId, async () => {
      continuations += 1;
    });
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(continuations, 1);
    assert.equal(c.orchestrationCheckpoint, "plan-approved");
    assert.equal(c.readiness.find((item) => item.key === "profile")?.status, "pending");
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("legacy null-checkpoint intake wait is inferred and claimed exactly once", async () => {
    const caseId = await createCase();
    await db.update(onbCases).set({
      readiness: defaultReadiness(),
      checklistSnapshot: [],
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: null,
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbApprovals).values({
      organizationId: DEMO_ORGANIZATION_ID,
      caseId,
      agent: "intake",
      ruleRef: "legacy-intake",
      hitlPattern: "approve-before-act",
      recommendation: "Proceed",
      rationale: "Legacy decision persisted before restart",
      resumeAction: "continue-after-intake",
      status: "approved",
    });
    let continuations = 0;
    const continuation = async (_id: number, planApproved: boolean) => {
      continuations += 1;
      assert.equal(planApproved, false);
    };
    await Promise.all([
      reconcileDecidedApprovals(caseId, continuation),
      reconcileDecidedApprovals(caseId, continuation),
    ]);
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(continuations, 1);
    assert.equal(c.orchestrationCheckpoint, "intake-approved");
    assert.equal(c.readiness.find((item) => item.key === "profile")?.status, "ready");
    assert.deepEqual(c.checklistSnapshot, []);
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("legacy null-checkpoint plan wait repairs old profile state before exactly-once continuation", async () => {
    const caseId = await createCase();
    const readiness = defaultReadiness();
    const profile = readiness.find((item) => item.key === "profile");
    assert.ok(profile);
    profile.status = "in-progress";
    profile.note = "Legacy intake approval did not update readiness";
    await db.update(onbCases).set({
      readiness,
      checklistSnapshot: [],
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: null,
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbApprovals).values([
      {
        organizationId: DEMO_ORGANIZATION_ID,
        caseId,
        agent: "intake",
        ruleRef: "legacy-completed-intake",
        hitlPattern: "approve-before-act",
        recommendation: "Intake approved",
        rationale: "Historical approval",
        resumeAction: "continue-after-intake",
        status: "approved",
      },
      {
        organizationId: DEMO_ORGANIZATION_ID,
        caseId,
        agent: "plan",
        ruleRef: "legacy-plan",
        hitlPattern: "approve-before-act",
        recommendation: "Plan approved",
        rationale: "Decision persisted before restart",
        resumeAction: "continue-after-plan",
        status: "pending",
      },
    ]);
    let continuations = 0;
    assert.equal(
      await reconcileDecidedApprovals(caseId, async () => {
        continuations += 1;
      }),
      false,
    );
    assert.equal(continuations, 0);
    await db.update(onbApprovals).set({ status: "approved" }).where(and(
      eq(onbApprovals.caseId, caseId),
      eq(onbApprovals.resumeAction, "continue-after-plan"),
    ));
    await Promise.all([
      reconcileDecidedApprovals(caseId, async (_id, planApproved) => {
        continuations += 1;
        assert.equal(planApproved, true);
        const [duringContinuation] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
        assert.equal(
          duringContinuation.readiness.find((item) => item.key === "profile")?.status,
          "ready",
        );
        assert.equal(
          checklistStageBlockers(duringContinuation, "before-workstreams").length,
          0,
        );
      }),
      reconcileDecidedApprovals(caseId, async () => {
        continuations += 1;
      }),
    ]);
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(continuations, 1);
    assert.equal(c.orchestrationCheckpoint, "plan-approved");
    assert.equal(c.readiness.find((item) => item.key === "profile")?.status, "ready");
    assert.deepEqual(c.checklistSnapshot, []);
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("legacy plan claim atomically persists profile repair across continuation interruption", async () => {
    const caseId = await createCase();
    const readiness = defaultReadiness();
    const profile = readiness.find((item) => item.key === "profile");
    assert.ok(profile);
    profile.status = "in-progress";
    await db.update(onbCases).set({
      readiness,
      checklistSnapshot: [],
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: null,
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbApprovals).values([
      {
        organizationId: DEMO_ORGANIZATION_ID,
        caseId,
        agent: "intake",
        ruleRef: "legacy-atomic-intake",
        hitlPattern: "approve-before-act",
        recommendation: "Intake approved",
        rationale: "Historical",
        resumeAction: "continue-after-intake",
        status: "approved",
      },
      {
        organizationId: DEMO_ORGANIZATION_ID,
        caseId,
        agent: "plan",
        ruleRef: "legacy-atomic-plan",
        hitlPattern: "approve-before-act",
        recommendation: "Plan approved",
        rationale: "Historical",
        resumeAction: "continue-after-plan",
        status: "approved",
      },
    ]);
    let continuationAttempts = 0;
    await assert.rejects(
      reconcileDecidedApprovals(caseId, async () => {
        continuationAttempts += 1;
        throw new Error("simulated crash immediately after continuation claim commit");
      }),
      /simulated crash/,
    );
    const [afterCrash] = await db.select().from(onbCases).where(eq(onbCases.id, caseId));
    assert.equal(afterCrash.orchestrationCheckpoint, "plan-approved");
    assert.equal(afterCrash.readiness.find((item) => item.key === "profile")?.status, "ready");
    assert.equal(checklistStageBlockers(afterCrash, "before-workstreams").length, 0);
    assert.deepEqual(afterCrash.checklistSnapshot, []);
    // Waiting-state reconciliation cannot create a duplicate continuation;
    // watcher recovery consumes the already durable plan-approved checkpoint.
    assert.equal(
      await reconcileDecidedApprovals(caseId, async () => {
        continuationAttempts += 1;
      }),
      false,
    );
    assert.equal(continuationAttempts, 1);
    await db.delete(onbApprovals).where(eq(onbApprovals.caseId, caseId));
  });

  test("expired handoff fences stale claim and commit", async () => {
    const operation = identity(await createCase(), "handoff", true);
    const first = await claimEffectDispatch({
      ...operation,
      owner: "worker-old",
      expectedFencingToken: 0,
      leaseMs: 60_000,
    });
    assert.deepEqual(first, {
      kind: "claimed",
      fencingToken: 1,
      providerIdempotencyKey: operation.logicalOperationKey,
    });
    await db
      .update(onbEffectJournal)
      .set({ claimUntil: new Date("2000-01-01T00:00:00Z") })
      .where(eq(onbEffectJournal.logicalOperationKey, operation.logicalOperationKey));
    const staleClaim = await claimEffectDispatch({
      ...operation,
      owner: "worker-old",
      expectedFencingToken: 0,
    });
    assert.deepEqual(staleClaim, { kind: "not_claimed" });
    const second = await claimEffectDispatch({
      ...operation,
      owner: "worker-new",
      expectedFencingToken: 1,
    });
    assert.deepEqual(second, {
      kind: "claimed",
      fencingToken: 2,
      providerIdempotencyKey: operation.logicalOperationKey,
    });
    assert.equal(
      await confirmEffect({
        logicalOperationKey: operation.logicalOperationKey,
        organizationId: operation.organizationId,
        owner: "worker-old",
        fencingToken: 1,
      }),
      false,
    );
    assert.equal(
      await confirmEffect({
        logicalOperationKey: operation.logicalOperationKey,
        organizationId: operation.organizationId,
        owner: "worker-new",
        fencingToken: 2,
        externalEffectId: "provider-123",
      }),
      true,
    );
  });

  test("confirmed effects are reused without regard to plan version", async () => {
    const operation = identity(await createCase(), "reuse", true);
    assert.deepEqual(
      await claimEffectDispatch({ ...operation, owner: "worker-a", expectedFencingToken: 0 }),
      {
        kind: "claimed",
        fencingToken: 1,
        providerIdempotencyKey: operation.logicalOperationKey,
      },
    );
    await confirmEffect({
      logicalOperationKey: operation.logicalOperationKey,
      organizationId: operation.organizationId,
      owner: "worker-a",
      fencingToken: 1,
      externalEffectId: "remote-effect",
    });
    assert.deepEqual(
      await claimEffectDispatch({ ...operation, owner: "unrelated-plan", expectedFencingToken: 1 }),
      { kind: "reuse_confirmed", externalEffectId: "remote-effect" },
    );
  });

  test("a tenant cannot confirm or claim another tenant's journal entry", async () => {
    const operation = identity(await createCase(), "tenant-bound", true);
    const claim = await claimEffectDispatch({
      ...operation,
      owner: "worker-a",
      expectedFencingToken: 0,
    });
    assert.equal(claim.kind, "claimed");
    assert.equal(
      await confirmEffect({
        logicalOperationKey: operation.logicalOperationKey,
        organizationId: "different-tenant",
        owner: "worker-a",
        fencingToken: 1,
      }),
      false,
    );
    await assert.rejects(
      claimEffectDispatch({
        ...operation,
        organizationId: "different-tenant",
        owner: "worker-b",
        expectedFencingToken: 1,
      }),
      (error: unknown) => {
        const cause = (error as { cause?: { code?: string } }).cause;
        // The foreign-key rejection proves the cross-tenant claim failed
        // closed before another organization's journal row could be created.
        return cause?.code === "23503";
      },
    );
  });

  test("ambiguous non-idempotent writes stop for manual repair", async () => {
    const operation = identity(await createCase(), "ambiguous");
    await claimEffectDispatch({ ...operation, owner: "worker-a", expectedFencingToken: 0 });
    assert.equal(
      await markAmbiguousEffectForManualRepair({
        logicalOperationKey: operation.logicalOperationKey,
        organizationId: operation.organizationId,
        owner: "worker-a",
        fencingToken: 1,
        error: "provider timed out after request body was sent",
      }),
      true,
    );
    assert.deepEqual(
      await claimEffectDispatch({ ...operation, owner: "worker-b", expectedFencingToken: 1 }),
      { kind: "manual_repair_required" },
    );
  });

  test("a crashed non-idempotent dispatch becomes manual repair instead of being reclaimed", async () => {
    const operation = identity(await createCase(), "crashed-non-idempotent");
    await claimEffectDispatch({ ...operation, owner: "worker-old", expectedFencingToken: 0 });
    await db
      .update(onbEffectJournal)
      .set({ claimUntil: new Date("2000-01-01T00:00:00Z") })
      .where(eq(onbEffectJournal.logicalOperationKey, operation.logicalOperationKey));
    assert.deepEqual(
      await claimEffectDispatch({ ...operation, owner: "worker-new", expectedFencingToken: 1 }),
      { kind: "manual_repair_required" },
    );
  });

  test("the recovery sweep surfaces a crashed non-idempotent dispatch without a retry", async () => {
    const operation = identity(await createCase(), "swept-non-idempotent");
    await claimEffectDispatch({ ...operation, owner: "worker-old", expectedFencingToken: 0 });
    await db
      .update(onbEffectJournal)
      .set({ claimUntil: new Date("2000-01-01T00:00:00Z") })
      .where(eq(onbEffectJournal.logicalOperationKey, operation.logicalOperationKey));
    const swept = await sweepExpiredNonIdempotentEffects();
    assert.ok(
      swept.some((row) => row.logicalOperationKey === operation.logicalOperationKey),
    );
    assert.deepEqual(
      await claimEffectDispatch({ ...operation, owner: "worker-new", expectedFencingToken: 1 }),
      { kind: "manual_repair_required" },
    );
  });

  test("a logical key cannot be rebound to another case", async () => {
    const operation = identity(await createCase(), "case-binding");
    await claimEffectDispatch({ ...operation, owner: "worker-a", expectedFencingToken: 0 });
    await assert.rejects(
      claimEffectDispatch({
        ...operation,
        caseId: await createCase(),
        owner: "worker-b",
        expectedFencingToken: 1,
      }),
      /already bound to a different effect/,
    );
  });
});