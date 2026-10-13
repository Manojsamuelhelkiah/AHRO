import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisions,
  onbGovernanceDispatchMarkers,
} from "@workspace/db";

type DispatchTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class GovernanceDispatchBlockedError extends Error {
  constructor(message = "Governance changes are blocked while a provider dispatch is active or ambiguous.") {
    super(message);
    this.name = "GovernanceDispatchBlockedError";
  }
}

export type GovernanceDispatchFence = {
  dispatchId: string;
  operation: string;
  capturedAt: string;
  decisions: Array<{ key: string; revision: number; status: string; approvedAt: string | null }>;
  verifiedAuthorities: Array<{ id: number; role: string; assigneeUserId: string; expiresAt: string | null }>;
  /** Passed by a runtime caller from the adopted case snapshot; never replaced with current policy. */
  adoptedCaseSnapshot: Record<string, unknown> | null;
};

export type GovernanceDispatchResult<T> =
  | { disposition: "sent"; value: T }
  | { disposition: "definitive-not-sent"; value: T }
  | { disposition: "unknown"; value: T };

function lockKey(organizationId: string) {
  return `governance-dispatch-mutation:${organizationId}`;
}

/** Acquire before any governance state read that can lead to a mutation. */
export async function acquireGovernanceDispatchMutationLock(
  tx: Pick<DispatchTransaction, "execute">,
  organizationId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(organizationId)}))`);
}

export async function hasActiveGovernanceDispatchMarker(
  tx: Pick<DispatchTransaction, "select">,
  organizationId: string,
): Promise<boolean> {
  const [marker] = await tx.select({ id: onbGovernanceDispatchMarkers.id })
    .from(onbGovernanceDispatchMarkers)
    .where(and(
      eq(onbGovernanceDispatchMarkers.organizationId, organizationId),
      inArray(onbGovernanceDispatchMarkers.status, ["dispatching", "ambiguous"]),
    ))
    .limit(1);
  return Boolean(marker);
}

/**
 * Required at the start of every governance mutation transaction and by
 * snapshot adoption/rebase writers. Its transaction-scoped advisory lock is
 * intentionally shared with withGovernanceDispatch's marker claim.
 */
export async function assertGovernanceMutationAllowed(
  tx: DispatchTransaction,
  organizationId: string,
): Promise<void> {
  await acquireGovernanceDispatchMutationLock(tx, organizationId);
  if (await hasActiveGovernanceDispatchMarker(tx, organizationId)) {
    throw new GovernanceDispatchBlockedError();
  }
}

async function captureFence(
  tx: DispatchTransaction,
  organizationId: string,
  dispatchId: string,
  operation: string,
  adoptedCaseSnapshot: Record<string, unknown> | undefined,
): Promise<GovernanceDispatchFence> {
  const now = new Date();
  // Transaction clients issue one statement at a time; keeping these reads
  // sequential avoids driver-level query interleaving while the org fence is
  // held.
  const decisions = await tx.select({
      key: onbGovernanceDecisions.key,
      revision: onbGovernanceDecisions.revision,
      status: onbGovernanceDecisions.status,
      approvedAt: onbGovernanceDecisions.approvedAt,
    }).from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.isCurrent, true),
    )).orderBy(onbGovernanceDecisions.key);
  // Historical specialist grants are deliberately absent from every new
  // dispatch fence. The live gate revalidates versioned permission receipts.
  const verifiedAuthorities: Array<{ id: number; role: string; assigneeUserId: string; expiresAt: Date | null }> = [];
  return {
    dispatchId,
    operation,
    capturedAt: now.toISOString(),
    decisions: decisions.map((row) => ({
      ...row,
      approvedAt: row.approvedAt?.toISOString() ?? null,
    })),
    verifiedAuthorities: verifiedAuthorities.map((row) => ({
      ...row,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    })),
    adoptedCaseSnapshot: adoptedCaseSnapshot ?? null,
  };
}

/**
 * Commits a no-lease marker before external I/O. The callback is deliberately
 * outside the SQL transaction: a process crash or unprovable provider result
 * leaves a durable active/ambiguous blocker rather than silently reopening a
 * race with governance mutations.
 */
export async function withGovernanceDispatch<T>(
  options: {
    organizationId: string;
    operation: string;
    /** Runs while the shared organization lock is held, before any marker/I/O. */
    beforeDispatch?: (input: { tx: DispatchTransaction; fence: GovernanceDispatchFence }) => Promise<void>;
    /** Runtime-provided adopted case policy/snapshot identity, if this write is case-bound. */
    adoptedCaseSnapshot?: Record<string, unknown>;
  },
  callback: (fence: GovernanceDispatchFence) => Promise<GovernanceDispatchResult<T> | T>,
): Promise<T> {
  const dispatchId = randomUUID();
  const claimOwner = randomUUID();
  const fence = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, options.organizationId);
    const captured = await captureFence(
      tx, options.organizationId, dispatchId, options.operation, options.adoptedCaseSnapshot,
    );
    // A policy deny or another known preflight failure occurs before durable
    // marker creation, so it cannot become a false ambiguous provider write.
    await options.beforeDispatch?.({ tx, fence: captured });
    await tx.insert(onbGovernanceDispatchMarkers).values({
      organizationId: options.organizationId,
      dispatchId,
      operation: options.operation,
      status: "dispatching",
      claimOwner,
      fence: captured,
    });
    return captured;
  });
  try {
    const callbackResult = await callback(fence);
    // Transitional compatibility for existing provider callers while they
    // move authorization into beforeDispatch. A legacy blockedReason result is
    // a definitive non-send, not a successful provider dispatch. Any other
    // unclassified result is fail-closed as ambiguous.
    const result: GovernanceDispatchResult<T> = (
      callbackResult &&
      typeof callbackResult === "object" &&
      "disposition" in callbackResult &&
      ["sent", "definitive-not-sent", "unknown"].includes(String(callbackResult.disposition))
    )
      ? callbackResult as GovernanceDispatchResult<T>
      : (
        callbackResult &&
        typeof callbackResult === "object" &&
        "blockedReason" in callbackResult
      )
        ? {
            disposition: (callbackResult as { blockedReason?: unknown }).blockedReason
              ? "definitive-not-sent"
              : "sent",
            value: callbackResult as T,
          }
        : { disposition: "unknown", value: callbackResult as T };
    await db.update(onbGovernanceDispatchMarkers).set(
      result.disposition === "unknown"
        ? { status: "ambiguous", lastError: "Provider callback returned an ambiguous outcome" }
        : {
            status: "finalized",
            finalizedAt: new Date(),
            lastError: result.disposition === "definitive-not-sent"
              ? "Provider dispatch definitively did not send"
              : null,
          },
    ).where(and(
      eq(onbGovernanceDispatchMarkers.organizationId, options.organizationId),
      eq(onbGovernanceDispatchMarkers.dispatchId, dispatchId),
      eq(onbGovernanceDispatchMarkers.claimOwner, claimOwner),
      eq(onbGovernanceDispatchMarkers.status, "dispatching"),
    ));
    return result.value;
  } catch (error) {
    await db.update(onbGovernanceDispatchMarkers).set({
      status: "ambiguous",
      lastError: `Provider callback failed: ${String(error).slice(0, 500)}`,
    }).where(and(
      eq(onbGovernanceDispatchMarkers.organizationId, options.organizationId),
      eq(onbGovernanceDispatchMarkers.dispatchId, dispatchId),
      eq(onbGovernanceDispatchMarkers.claimOwner, claimOwner),
      eq(onbGovernanceDispatchMarkers.status, "dispatching"),
    ));
    throw error;
  }
}

/** Trusted reconciliation path; authorization belongs to the governance API service. */
export async function finalizeAmbiguousGovernanceDispatch(
  organizationId: string,
  dispatchId: string,
  reconciliationReference: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await acquireGovernanceDispatchMutationLock(tx, organizationId);
    const [marker] = await tx.select({ id: onbGovernanceDispatchMarkers.id })
      .from(onbGovernanceDispatchMarkers)
      .where(and(
        eq(onbGovernanceDispatchMarkers.organizationId, organizationId),
        eq(onbGovernanceDispatchMarkers.dispatchId, dispatchId),
        eq(onbGovernanceDispatchMarkers.status, "ambiguous"),
      ))
      .for("update");
    if (!marker) return false;
    await tx.update(onbGovernanceDispatchMarkers).set({
      status: "finalized",
      finalizedAt: new Date(),
      lastError: `Reconciled: ${reconciliationReference}`,
    }).where(eq(onbGovernanceDispatchMarkers.id, marker.id));
    return true;
  });
}