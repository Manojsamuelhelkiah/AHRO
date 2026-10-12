import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, onbCases, onbEffectJournal } from "@workspace/db";
import { isSyntheticOfflineCase, isUatRunIsolatedCase, sampleCandidateEmailEligible } from "./synthetic-offline";
import { isRetiredControllerCase } from "./controller-retirement";
import { getUatCaseIsolation } from "./uat-isolation";

type DispatchGuardContext = {
  caseId: number;
  organizationId: string;
};

type DispatchGuardOptions<T> = {
  /** Server-owned candidate email path only; still acquires the durable marker. */
  operation?: "candidate-email";
  /**
   * Offline cases never acquire a provider-dispatch record. Their caller may
   * still persist a blocked/logged-only timeline row in this branch.
   */
  onOffline?: (
    caseRow: typeof onbCases.$inferSelect,
  ) => Promise<T>;
  /**
   * A resolved callback can still report an ambiguous provider outcome. Keep
   * that guard unknown rather than treating the callback's return as success.
   */
  isUnknownResult?: (result: T) => boolean;
};

type DispatchGuardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const dispatchContext = new AsyncLocalStorage<DispatchGuardContext>();
const GUARD_TOOL = "provider-dispatch-guard";
const GUARD_ARGUMENTS_HASH = createHash("sha256")
  .update("provider-dispatch-guard:v1")
  .digest("hex");

function mutationLockKey(organizationId: string, caseId: number): string {
  return `provider-dispatch-mutation:${organizationId}:${caseId}`;
}

/**
 * Serializes a case-policy mutation with the short transaction that makes a
 * provider-dispatch marker durable. Callers must acquire this before reading
 * the case and checking `hasActiveCaseDispatchMarker`; otherwise a recovery
 * worker could commit its marker immediately after a mutation checked.
 */
export async function acquireCaseDispatchMutationLock(
  tx: Pick<DispatchGuardTransaction, "execute">,
  organizationId: string,
  caseId: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${mutationLockKey(organizationId, caseId)}))`,
  );
}

/**
 * A dispatch in progress (or one that ended ambiguously) cannot safely be
 * superseded by a policy/context mutation. It must be reconciled first.
 */
export async function hasActiveCaseDispatchMarker(
  tx: Pick<DispatchGuardTransaction, "select">,
  organizationId: string,
  caseId: number,
): Promise<boolean> {
  const [marker] = await tx
    .select({ key: onbEffectJournal.logicalOperationKey })
    .from(onbEffectJournal)
    .where(and(
      eq(onbEffectJournal.organizationId, organizationId),
      eq(onbEffectJournal.caseId, caseId),
      eq(onbEffectJournal.toolName, GUARD_TOOL),
      inArray(onbEffectJournal.status, [
        "dispatching",
        "unknown_effect_manual_repair",
      ]),
    ))
    .limit(1);
  return Boolean(marker);
}

/**
 * Acquire a short-lived durable in-flight marker before crossing a provider
 * boundary. The parent KEY SHARE and guard insert commit before callback I/O;
 * no database connection is held while a provider is called. A reset's
 * parent FOR UPDATE therefore sees the committed dispatching marker and
 * blocks fail-closed instead of racing an external effect.
 *
 * Dispatching markers deliberately have no lease. A process crash leaves the
 * row active for manual reconciliation; it is never auto-reclaimed.
 */
export async function withCaseDispatchGuard<T>(
  caseId: number,
  callback: (caseRow: typeof onbCases.$inferSelect) => Promise<T>,
  options: DispatchGuardOptions<T> = {},
): Promise<T | undefined> {
  const inherited = dispatchContext.getStore();
  if (inherited?.caseId === caseId) {
    const [caseRow] = await db
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, caseId),
        eq(onbCases.organizationId, inherited.organizationId),
      ));
    if (!caseRow) return undefined;
    if (isRetiredControllerCase(caseRow)) return undefined;
    const isolation = await getUatCaseIsolation(caseRow);
    const emailException = options.operation === "candidate-email" &&
      sampleCandidateEmailEligible(caseRow) && !isolation.linkedToRun;
    if (isolation.linkedToRun || (!emailException &&
      (isolation.isolated || isSyntheticOfflineCase(caseRow)))) {
      return options.onOffline
        ? options.onOffline(caseRow)
        : undefined;
    }
    return callback(caseRow);
  }

  const guardKey = `provider-dispatch-guard:${caseId}:${randomUUID()}`;
  const guardOwner = randomUUID();
  // Resolve the tenant before opening the transaction so the advisory lock
  // order is identical to policy/context writers: advisory lock, then case
  // row. Organization is immutable for an existing onboarding case.
  const [candidate] = await db
    .select()
    .from(onbCases)
    .where(eq(onbCases.id, caseId));
  if (!candidate) return undefined;
  if (isRetiredControllerCase(candidate)) return undefined;
  // Run ownership is an independent fence for a damaged/migrated case whose
  // scenario key is unavailable. Do not create the guard/effect marker.
  const isolation = await getUatCaseIsolation(candidate);
  const emailException = options.operation === "candidate-email" &&
    sampleCandidateEmailEligible(candidate) && !isolation.linkedToRun;
  if (isolation.linkedToRun || (isolation.isolated && !emailException)) {
    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, caseId),
      eq(onbCases.organizationId, candidate.organizationId),
    ));
    if (!caseRow) return undefined;
    if (isRetiredControllerCase(caseRow)) return undefined;
    return options.onOffline ? options.onOffline(caseRow) : undefined;
  }
  const acquired = await db.transaction(async (tx) => {
    await acquireCaseDispatchMutationLock(tx, candidate.organizationId, caseId);
    const [caseRow] = await tx
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, caseId),
        eq(onbCases.organizationId, candidate.organizationId),
      ))
      .for("key share");
    if (!caseRow) return { kind: "missing" as const };
    if (isRetiredControllerCase(caseRow)) return { kind: "missing" as const };
    if ((isUatRunIsolatedCase(caseRow) || isSyntheticOfflineCase(caseRow)) &&
      !(options.operation === "candidate-email" && sampleCandidateEmailEligible(caseRow))) {
      return { kind: "offline" as const, caseRow };
    }
    await tx.insert(onbEffectJournal).values({
      logicalOperationKey: guardKey,
      organizationId: caseRow.organizationId,
      tenantId: caseRow.organizationId,
      caseId: caseRow.id,
      toolName: GUARD_TOOL,
      argumentsHash: GUARD_ARGUMENTS_HASH,
      providerIdempotency: false,
      status: "dispatching",
      claimOwner: guardOwner,
      claimUntil: null,
      dispatchStartedAt: new Date(),
    });
    return { kind: "claimed" as const, caseRow };
  });

  if (acquired.kind === "missing") return undefined;
  if (acquired.kind === "offline") {
    return options.onOffline
      ? options.onOffline(acquired.caseRow)
      : undefined;
  }

  const context = {
    caseId: acquired.caseRow.id,
    organizationId: acquired.caseRow.organizationId,
  };
  return dispatchContext.run(context, async () => {
    try {
      const result = await callback(acquired.caseRow);
      const unknown = options.isUnknownResult?.(result) ?? false;
      await db.update(onbEffectJournal).set(
        unknown
          ? {
              status: "unknown_effect_manual_repair",
              lastError: "Provider callback returned an ambiguous outcome",
              claimUntil: null,
              updatedAt: new Date(),
            }
          : {
              status: "confirmed",
              confirmedAt: new Date(),
              claimUntil: null,
              updatedAt: new Date(),
            },
      ).where(and(
        eq(onbEffectJournal.organizationId, acquired.caseRow.organizationId),
        eq(onbEffectJournal.logicalOperationKey, guardKey),
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.claimOwner, guardOwner),
      ));
      return result;
    } catch (error) {
      // Keep the durable row in an unknown/manual-repair state. If the
      // process dies before this update, dispatching is itself an active
      // blocker and there is intentionally no lease sweep to reclaim it.
      await db.update(onbEffectJournal).set({
        status: "unknown_effect_manual_repair",
        lastError: `Provider callback failed: ${String(error).slice(0, 500)}`,
        claimUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(onbEffectJournal.organizationId, acquired.caseRow.organizationId),
        eq(onbEffectJournal.logicalOperationKey, guardKey),
        eq(onbEffectJournal.status, "dispatching"),
        eq(onbEffectJournal.claimOwner, guardOwner),
      ));
      throw error;
    }
  });
}

export const providerDispatchGuardToolName = GUARD_TOOL;