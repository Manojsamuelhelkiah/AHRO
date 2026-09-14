import { db } from "@workspace/db";
import { onbEffectJournal } from "@workspace/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { appendProtectedAuditInTransaction } from "./protected-audit";
import { getUatCaseIsolation } from "./uat-isolation";

export type EffectJournalIdentity = {
  logicalOperationKey: string;
  organizationId: string;
  tenantId: string;
  caseId: number;
  toolName: string;
  argumentsHash: string;
  providerIdempotency: boolean;
};

export type EffectDispatchClaim =
  | {
      kind: "claimed";
      fencingToken: number;
      /** Pass this exact stable key to providers that support idempotency. */
      providerIdempotencyKey: string;
    }
  | { kind: "reuse_confirmed"; externalEffectId: string | null }
  | { kind: "manual_repair_required" }
  | { kind: "not_claimed" };

/** Create the single durable row for a logical remote operation. */
export async function ensureEffectJournalEntry(input: EffectJournalIdentity) {
  if ((await getUatCaseIsolation({ organizationId: input.organizationId, id: input.caseId })).isolated) {
    throw new Error("UAT-isolated cases cannot create ordinary durable effect-journal entries.");
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(onbEffectJournal)
      .values(input)
      .onConflictDoNothing({
        target: [
          onbEffectJournal.organizationId,
          onbEffectJournal.logicalOperationKey,
        ],
      })
      .returning();
    const [entry] = await tx
      .select()
      .from(onbEffectJournal)
      .where(and(
        eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
        eq(onbEffectJournal.organizationId, input.organizationId),
      ));
    if (!entry) throw new Error("Effect journal entry could not be created");
    if (
      entry.organizationId !== input.organizationId ||
      entry.tenantId !== input.tenantId ||
      entry.caseId !== input.caseId ||
      entry.toolName !== input.toolName ||
      entry.argumentsHash !== input.argumentsHash ||
      entry.providerIdempotency !== input.providerIdempotency
    ) {
      throw new Error("Logical operation key is already bound to a different effect");
    }
    if (created) {
      await appendProtectedAuditInTransaction(tx, {
        organizationId: input.organizationId,
        actorKind: "system",
        actorAuthority: "durable-effect-journal",
        action: "onboarding.connector-effect.journaled",
        outcome: "success",
        objectType: "connector-effect",
        objectId: input.logicalOperationKey,
        caseReference: `case:${input.caseId}`,
        source: "effect-journal",
        correlationId: input.logicalOperationKey,
        payload: {
          toolName: input.toolName,
          providerIdempotency: input.providerIdempotency,
          journalStatus: entry.status,
        },
      });
    }
    return entry;
  });
}

/**
 * A confirmed operation is an immutable fact, not a new authorization
 * request. Callers may safely short-circuit a replay before evaluating
 * unrelated current workstream blockers.
 */
export async function isConfirmedEffect(input: EffectJournalIdentity): Promise<boolean> {
  if ((await getUatCaseIsolation({ organizationId: input.organizationId, id: input.caseId })).isolated) return false;
  const [entry] = await db
    .select()
    .from(onbEffectJournal)
    .where(and(
      eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
      eq(onbEffectJournal.organizationId, input.organizationId),
    ));
  return Boolean(
    entry &&
    entry.status === "confirmed" &&
    entry.tenantId === input.tenantId &&
    entry.caseId === input.caseId &&
    entry.toolName === input.toolName &&
    entry.argumentsHash === input.argumentsHash &&
    entry.providerIdempotency === input.providerIdempotency,
  );
}

async function currentDisposition(
  logicalOperationKey: string,
  organizationId: string,
): Promise<EffectDispatchClaim> {
  const [entry] = await db
    .select()
    .from(onbEffectJournal)
    .where(and(
      eq(onbEffectJournal.logicalOperationKey, logicalOperationKey),
      eq(onbEffectJournal.organizationId, organizationId),
    ));
  if (entry?.status === "confirmed") {
    return { kind: "reuse_confirmed", externalEffectId: entry.externalEffectId };
  }
  if (entry?.status === "unknown_effect_manual_repair") {
    return { kind: "manual_repair_required" };
  }
  return { kind: "not_claimed" };
}

/**
 * Compare-and-set dispatch claim. Callers must present the token they read;
 * only that exact generation may advance it, so stale workers cannot claim.
 *
 * Lease decisions use PostgreSQL time. Expired non-idempotent dispatches are
 * ambiguous by definition and are stopped for reconciliation instead of being
 * reclaimed; only provider-idempotent calls can safely be retried after a crash.
 */
export async function claimEffectDispatch(input: EffectJournalIdentity & {
  owner: string;
  expectedFencingToken: number;
  leaseMs?: number;
}): Promise<EffectDispatchClaim> {
  const entry = await ensureEffectJournalEntry(input);
  if (entry.status === "confirmed" || entry.status === "unknown_effect_manual_repair") {
    return currentDisposition(input.logicalOperationKey, input.organizationId);
  }

  if (!input.providerIdempotency) {
    const ambiguous = await db.transaction(async (tx) => {
      const [updated] = await tx
      .update(onbEffectJournal)
      .set({
        status: "unknown_effect_manual_repair",
        claimUntil: null,
        lastError: "Dispatch lease expired before the external effect was confirmed",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
          eq(onbEffectJournal.organizationId, input.organizationId),
          eq(onbEffectJournal.status, "dispatching"),
          eq(onbEffectJournal.providerIdempotency, false),
          eq(onbEffectJournal.fencingToken, input.expectedFencingToken),
          sql`${onbEffectJournal.claimUntil} <= now()`,
        ),
      )
      .returning({ key: onbEffectJournal.logicalOperationKey });
      if (updated) {
        await appendProtectedAuditInTransaction(tx, {
          organizationId: input.organizationId,
          actorKind: "system",
          actorAuthority: "durable-effect-journal",
          action: "onboarding.connector-effect.manual-repair-required",
          outcome: "failure",
          objectType: "connector-effect",
          objectId: input.logicalOperationKey,
          caseReference: `case:${input.caseId}`,
          reviewedRevision: input.expectedFencingToken,
          source: "effect-journal",
          correlationId: input.logicalOperationKey,
          payload: { errorRecorded: true },
        });
      }
      return updated;
    });
    if (ambiguous) return { kind: "manual_repair_required" };
  }

  const leaseMs = input.leaseMs ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("Effect dispatch lease must be a positive integer");
  }
  const claimed = await db.transaction(async (tx) => {
    const [updated] = await tx
    .update(onbEffectJournal)
    .set({
      status: "dispatching",
      fencingToken: input.expectedFencingToken + 1,
      claimOwner: input.owner,
      claimUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
      dispatchStartedAt: sql`now()`,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
        eq(onbEffectJournal.organizationId, input.organizationId),
        eq(onbEffectJournal.fencingToken, input.expectedFencingToken),
        or(
          sql`${onbEffectJournal.status} in ('ready', 'failed')`,
          and(
            eq(onbEffectJournal.status, "dispatching"),
            eq(onbEffectJournal.providerIdempotency, true),
            sql`${onbEffectJournal.claimUntil} <= now()`,
          ),
        ),
      ),
    )
    .returning({ fencingToken: onbEffectJournal.fencingToken });
    if (updated) {
      await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorKind: "system",
      actorAuthority: "durable-effect-journal",
      action: "onboarding.connector-effect.dispatch-claimed",
      outcome: "success",
      objectType: "connector-effect",
      objectId: input.logicalOperationKey,
      caseReference: `case:${input.caseId}`,
       reviewedRevision: updated.fencingToken,
      source: "effect-journal",
      correlationId: input.logicalOperationKey,
      payload: { providerIdempotency: input.providerIdempotency },
      });
    }
    return updated;
  });
  return claimed
    ? {
        kind: "claimed",
        fencingToken: claimed.fencingToken,
        providerIdempotencyKey: input.logicalOperationKey,
      }
    : currentDisposition(input.logicalOperationKey, input.organizationId);
}

/** Owner-and-token fenced confirmation; a stale worker gets false. */
export async function confirmEffect(input: {
  logicalOperationKey: string;
  organizationId: string;
  owner: string;
  fencingToken: number;
  externalEffectId?: string;
}): Promise<boolean> {
  const updated = await db.transaction(async (tx) => {
    const [confirmed] = await tx
    .update(onbEffectJournal)
    .set({
      status: "confirmed",
      externalEffectId: input.externalEffectId ?? null,
      confirmedAt: sql`now()`,
      claimUntil: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
        eq(onbEffectJournal.organizationId, input.organizationId),
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.claimOwner, input.owner),
        eq(onbEffectJournal.fencingToken, input.fencingToken),
      ),
    )
    .returning({ key: onbEffectJournal.logicalOperationKey, caseId: onbEffectJournal.caseId });
    if (confirmed) {
      await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorKind: "system",
      actorAuthority: "durable-effect-journal",
      action: "onboarding.connector-effect.confirmed",
      outcome: "success",
      objectType: "connector-effect",
      objectId: input.logicalOperationKey,
      caseReference: confirmed.caseId === null ? null : `case:${confirmed.caseId}`,
      reviewedRevision: input.fencingToken,
      source: "effect-journal",
      correlationId: input.logicalOperationKey,
      payload: { externalEffectReferencePresent: Boolean(input.externalEffectId) },
      });
    }
    return confirmed;
  });
  return Boolean(updated);
}

/** A policy denial before provider I/O releases the fenced claim for retry. */
export async function rejectEffectDispatchBeforeWrite(input: {
  logicalOperationKey: string;
  organizationId: string;
  owner: string;
  fencingToken: number;
  reason: string;
}): Promise<boolean> {
  const [updated] = await db
    .update(onbEffectJournal)
    .set({
      status: "failed",
      lastError: input.reason.slice(0, 500),
      claimUntil: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
      eq(onbEffectJournal.organizationId, input.organizationId),
      eq(onbEffectJournal.status, "dispatching"),
      eq(onbEffectJournal.claimOwner, input.owner),
      eq(onbEffectJournal.fencingToken, input.fencingToken),
    ))
    .returning({ key: onbEffectJournal.logicalOperationKey });
  return Boolean(updated);
}
/**
 * A non-idempotent write that may have reached the provider is terminal until
 * a human reconciles it. The same fencing conditions prevent stale workers
 * from poisoning a newer claim.
 */
export async function markAmbiguousEffectForManualRepair(input: {
  logicalOperationKey: string;
  organizationId: string;
  owner: string;
  fencingToken: number;
  error: string;
}): Promise<boolean> {
  const updated = await db.transaction(async (tx) => {
    const [repaired] = await tx
    .update(onbEffectJournal)
    .set({
      status: "unknown_effect_manual_repair",
      lastError: input.error,
      claimUntil: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(onbEffectJournal.logicalOperationKey, input.logicalOperationKey),
        eq(onbEffectJournal.organizationId, input.organizationId),
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.providerIdempotency, false),
        eq(onbEffectJournal.claimOwner, input.owner),
        eq(onbEffectJournal.fencingToken, input.fencingToken),
      ),
    )
    .returning({ key: onbEffectJournal.logicalOperationKey, caseId: onbEffectJournal.caseId });
    if (repaired) {
      await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorKind: "system",
      actorAuthority: "durable-effect-journal",
      action: "onboarding.connector-effect.manual-repair-required",
      outcome: "failure",
      objectType: "connector-effect",
      objectId: input.logicalOperationKey,
      caseReference: repaired.caseId === null ? null : `case:${repaired.caseId}`,
      reviewedRevision: input.fencingToken,
      source: "effect-journal",
      correlationId: input.logicalOperationKey,
      payload: { errorRecorded: true },
      });
    }
    return repaired;
  });
  return Boolean(updated);
}

/**
 * Recovery sweep for crashes with no immediate retry. Returning rows lets a
 * future alerting workflow notify operators without repeating the transition.
 */
export async function sweepExpiredNonIdempotentEffects(): Promise<
  Array<{ logicalOperationKey: string; caseId: number | null }>
> {
  const rows = await db.transaction(async (tx) => {
    const recovered = await tx
    .update(onbEffectJournal)
    .set({
      status: "unknown_effect_manual_repair",
      claimUntil: null,
      lastError: "Dispatch lease expired before the external effect was confirmed",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.providerIdempotency, false),
        sql`${onbEffectJournal.claimUntil} <= now()`,
      ),
    )
    .returning({
      logicalOperationKey: onbEffectJournal.logicalOperationKey,
      organizationId: onbEffectJournal.organizationId,
      caseId: onbEffectJournal.caseId,
    });
    // Acquire chain locks in a stable order to avoid cross-tenant deadlocks.
    for (const row of [...recovered].sort((a, b) => a.organizationId.localeCompare(b.organizationId))) {
      await appendProtectedAuditInTransaction(tx, {
        organizationId: row.organizationId,
        actorKind: "system",
        actorAuthority: "durable-effect-journal",
        action: "onboarding.connector-effect.manual-repair-required",
        outcome: "failure",
        objectType: "connector-effect",
        objectId: row.logicalOperationKey,
        caseReference: row.caseId === null ? null : `case:${row.caseId}`,
        source: "effect-journal",
        correlationId: row.logicalOperationKey,
        payload: { recoverySweep: true },
      });
    }
    return recovered;
  });
  return rows;
}
