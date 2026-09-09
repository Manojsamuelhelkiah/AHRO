import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbCases, onbEffectJournal } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
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