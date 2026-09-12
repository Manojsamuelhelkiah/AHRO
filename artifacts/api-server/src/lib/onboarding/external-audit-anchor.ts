import { createHash } from "node:crypto";
import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, onbAuditAnchorOutbox, onbAuditAnchorReceipts, onbAuditHeads } from "@workspace/db";
import type { OnboardingDbTransaction } from "./settings";
import { logger } from "../logger";

export type AuditAnchorOperation =
  | {
      kind: "checkpoint";
      organizationId: string;
      idempotencyKey: string;
      sequence: number;
      hash: string;
      retentionStatementPresent: boolean;
      legalHoldActive: boolean;
    }
  | {
      kind: "legal_hold";
      organizationId: string;
      idempotencyKey: string;
      legalHoldActive: boolean;
      reasonFingerprint: string;
      retentionStatementPresent: boolean;
    };

export type ExternalAnchorReceipt = {
  receiptVersion: number;
  providerId: string;
  providerKind: "simulated" | "external";
  operationKind: AuditAnchorOperation["kind"];
  idempotencyKey: string;
  organizationId: string;
  checkpointSequence?: number;
  checkpointHash?: string;
  legalHoldActive?: boolean;
  retentionStatementPresent?: boolean;
  reasonFingerprint?: string;
  proof: string;
  issuedAt: string;
};

/**
 * Implement this interface for a client-operated independent provider. The
 * service never handles provider credentials; an adapter owns that concern.
 * `independent` is a code-level claim made by the adapter, never a setting or
 * environment flag.
 */
export interface ExternalAuditAnchorProvider {
  readonly id: string;
  readonly kind: "simulated" | "external";
  readonly independent: boolean;
  /** Optional lower test/adapter bound; production remains bounded by default. */
  readonly timeoutMs?: number;
  /**
   * Must be idempotent for idempotencyKey and must apply updates
   * monotonically (or with a provider-side compare-and-set). A bounded
   * request can time out locally while the provider continues processing it,
   * so a later retry or a higher operation may arrive after that late
   * completion.
   */
  anchor(operation: AuditAnchorOperation): Promise<ExternalAnchorReceipt>;
  verifyReceipt(receipt: ExternalAnchorReceipt, operation: AuditAnchorOperation): Promise<boolean>;
  /** Reads the provider's current independently held checkpoint, not local DB state. */
  fetchCurrentCheckpoint(organizationId: string): Promise<ExternalAnchorReceipt | null>;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}

function simulationProof(operation: AuditAnchorOperation): string {
  return createHash("sha256").update(stable(operation)).digest("hex");
}

const simulationCheckpoints = new Map<string, ExternalAnchorReceipt>();
const simulationLegalHolds = new Map<string, ExternalAnchorReceipt>();

function simulationTransitionIsAtLeast(currentKey: string, incomingKey: string): boolean {
  const currentPart = currentKey.split(":").at(-1) ?? "";
  const incomingPart = incomingKey.split(":").at(-1) ?? "";
  const currentNumber = Number(currentPart);
  const incomingNumber = Number(incomingPart);
  if (Number.isSafeInteger(currentNumber) && Number.isSafeInteger(incomingNumber)) {
    return incomingNumber >= currentNumber;
  }
  return incomingKey >= currentKey;
}

const simulationProvider: ExternalAuditAnchorProvider = {
  id: "simulation",
  kind: "simulated",
  independent: false,
  async anchor(operation) {
    const receipt = {
      receiptVersion: 1,
      providerId: this.id,
      providerKind: this.kind,
      operationKind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      organizationId: operation.organizationId,
      ...(operation.kind === "checkpoint"
        ? { checkpointSequence: operation.sequence, checkpointHash: operation.hash }
        : {}),
      legalHoldActive: operation.legalHoldActive,
      retentionStatementPresent: operation.retentionStatementPresent,
      ...(operation.kind === "legal_hold" ? { reasonFingerprint: operation.reasonFingerprint } : {}),
      proof: simulationProof(operation),
      issuedAt: new Date().toISOString(),
    };
    if (operation.kind === "checkpoint") {
      const current = simulationCheckpoints.get(operation.organizationId);
      if (current?.idempotencyKey === operation.idempotencyKey) return current;
      // A late completion of a timed-out, lower checkpoint must never move
      // simulation state backwards. Equal sequences are a compare-and-set:
      // only the same hash can replace an existing checkpoint.
      if (
        !current ||
        (current.checkpointSequence ?? -1) < operation.sequence ||
        (
          current.checkpointSequence === operation.sequence &&
          current.checkpointHash === operation.hash
        )
      ) {
        simulationCheckpoints.set(operation.organizationId, receipt);
      }
    } else {
      const current = simulationLegalHolds.get(operation.organizationId);
      if (current?.idempotencyKey === operation.idempotencyKey) return current;
      if (!current || simulationTransitionIsAtLeast(current.idempotencyKey, operation.idempotencyKey)) {
        simulationLegalHolds.set(operation.organizationId, receipt);
      }
    }
    return receipt;
  },
  async verifyReceipt(receipt, operation) {
    return receipt.providerId === this.id &&
      receipt.providerKind === this.kind &&
      receipt.proof === simulationProof(operation);
  },
  async fetchCurrentCheckpoint(organizationId) {
    return simulationCheckpoints.get(organizationId) ?? null;
  },
};

let activeProvider: ExternalAuditAnchorProvider = simulationProvider;

/** Clients install their independently operated adapter at application boot. */
export function registerExternalAuditAnchorProvider(provider: ExternalAuditAnchorProvider): void {
  if (
    !provider.id.trim() ||
    provider.kind !== "external" ||
    !provider.independent ||
    (provider.timeoutMs !== undefined &&
      (!Number.isFinite(provider.timeoutMs) || provider.timeoutMs <= 0 || provider.timeoutMs > 120_000))
  ) {
    throw new Error("An external anchor provider must declare a non-empty id, kind external, and independent=true");
  }
  activeProvider = provider;
}

export function resetExternalAuditAnchorProviderForTests(): void {
  activeProvider = simulationProvider;
  simulationCheckpoints.clear();
  simulationLegalHolds.clear();
}

export function legalHoldReasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason.trim().slice(0, 2_000)).digest("hex").slice(0, 32);
}

export function currentExternalAuditAnchorProvider(): Pick<ExternalAuditAnchorProvider, "id" | "kind" | "independent"> {
  return activeProvider;
}

export async function enqueueAuditCheckpointInTransaction(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    sequence: number;
    hash: string;
    retentionStatementPresent?: boolean;
    legalHoldActive?: boolean;
  },
): Promise<void> {
  const idempotencyKey = `${input.organizationId}:checkpoint:${input.sequence}:${input.hash}`;
  await tx.insert(onbAuditAnchorOutbox).values({
    organizationId: input.organizationId,
    kind: "checkpoint",
    idempotencyKey,
    checkpointSequence: input.sequence,
    checkpointHash: input.hash,
    payload: {
      retentionStatementPresent: input.retentionStatementPresent ?? false,
      legalHoldActive: input.legalHoldActive ?? false,
    },
  }).onConflictDoNothing({
    target: [onbAuditAnchorOutbox.organizationId, onbAuditAnchorOutbox.idempotencyKey],
  });
}

export async function enqueueAuditLegalHoldInTransaction(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    active: boolean;
    reasonFingerprint: string;
    retentionStatementPresent: boolean;
    transitionId: string;
  },
): Promise<void> {
  const idempotencyKey = `${input.organizationId}:legal-hold-transition:${input.transitionId}`;
  await tx.insert(onbAuditAnchorOutbox).values({
    organizationId: input.organizationId,
    kind: "legal_hold",
    idempotencyKey,
    payload: {
      legalHoldActive: input.active,
      reasonFingerprint: input.reasonFingerprint,
      retentionStatementPresent: input.retentionStatementPresent,
    },
  }).onConflictDoNothing({
    target: [onbAuditAnchorOutbox.organizationId, onbAuditAnchorOutbox.idempotencyKey],
  });
}

function operationFromOutbox(row: typeof onbAuditAnchorOutbox.$inferSelect): AuditAnchorOperation {
  const payload = row.payload;
  if (row.kind === "checkpoint" && row.checkpointSequence !== null && row.checkpointHash !== null) {
    return {
      kind: "checkpoint",
      organizationId: row.organizationId,
      idempotencyKey: row.idempotencyKey,
      sequence: row.checkpointSequence,
      hash: row.checkpointHash,
      retentionStatementPresent: payload.retentionStatementPresent === true,
      legalHoldActive: payload.legalHoldActive === true,
    };
  }
  if (row.kind === "legal_hold") {
    return {
      kind: "legal_hold",
      organizationId: row.organizationId,
      idempotencyKey: row.idempotencyKey,
      legalHoldActive: payload.legalHoldActive === true,
      reasonFingerprint: typeof payload.reasonFingerprint === "string" ? payload.reasonFingerprint : "",
      retentionStatementPresent: payload.retentionStatementPresent === true,
    };
  }
  throw new Error(`Invalid audit anchor outbox row ${row.id}`);
}

function retryAt(attempts: number, now: Date): Date {
  const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 9));
  return new Date(now.getTime() + delay);
}

function receiptMatchesOperation(receipt: ExternalAnchorReceipt, operation: AuditAnchorOperation): boolean {
  if (
    receipt.operationKind !== operation.kind ||
    receipt.organizationId !== operation.organizationId ||
    receipt.idempotencyKey !== operation.idempotencyKey
  ) return false;
  if (operation.kind === "checkpoint") {
    return receipt.checkpointSequence === operation.sequence && receipt.checkpointHash === operation.hash;
  }
  return receipt.legalHoldActive === operation.legalHoldActive &&
    receipt.reasonFingerprint === operation.reasonFingerprint;
}

const PROVIDER_CALL_TIMEOUT_MS = 10_000;
export const externalAnchorProviderTimeoutMs = PROVIDER_CALL_TIMEOUT_MS;

async function boundedProviderCall<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = activeProvider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Delivers a bounded batch. Claiming uses a conditional update so multiple
 * application instances cannot both dispatch the same idempotency key. A
 * stale sending claim is retried because providers must honor the key.
 */
export async function runAuditAnchorTick(
  options: { organizationId?: string } = {},
): Promise<{ delivered: number; failed: number; remaining: number }> {
  const now = new Date();
  // A client may replace the simulation after rows were delivered. Keep the
  // simulation receipt as immutable evidence, but requeue the operation until
  // the active provider has its own receipt.
  const deliveredRows = await db.select().from(onbAuditAnchorOutbox).where(and(
    options.organizationId ? eq(onbAuditAnchorOutbox.organizationId, options.organizationId) : undefined,
    eq(onbAuditAnchorOutbox.status, "delivered"),
  ));
  for (const row of deliveredRows) {
    await db.transaction(async (tx) => {
      // This lock covers both provider-transition requeueing and claims. It
      // is intentionally held only for the database transition; provider
      // calls happen after the claim commits so stale-claim fencing remains
      // observable and recoverable by another instance.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`external-audit-anchor:${row.organizationId}`}))`);
      const [providerReceipt] = await tx.select({ id: onbAuditAnchorReceipts.id })
        .from(onbAuditAnchorReceipts)
        .where(and(
          eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
          eq(onbAuditAnchorReceipts.idempotencyKey, row.idempotencyKey),
          eq(onbAuditAnchorReceipts.providerId, activeProvider.id),
        ))
        .limit(1);
      if (!providerReceipt) {
        await tx.update(onbAuditAnchorOutbox).set({
          status: "pending",
          nextAttemptAt: now,
          lastError: `provider-transition-reanchor:${activeProvider.id}`,
          deliveredAt: null,
          receiptId: null,
        }).where(and(
          eq(onbAuditAnchorOutbox.id, row.id),
          eq(onbAuditAnchorOutbox.organizationId, row.organizationId),
          eq(onbAuditAnchorOutbox.status, "delivered"),
        ));
      }
    });
  }

  const candidates = await db.select().from(onbAuditAnchorOutbox).where(and(
    options.organizationId ? eq(onbAuditAnchorOutbox.organizationId, options.organizationId) : undefined,
    or(eq(onbAuditAnchorOutbox.status, "pending"), eq(onbAuditAnchorOutbox.status, "failed"), eq(onbAuditAnchorOutbox.status, "sending")),
    lte(onbAuditAnchorOutbox.nextAttemptAt, now),
    // Select only the head of each tenant's undelivered sequence before the
    // global due-time ordering and batch limit. Without this predicate, 25
    // later rows can crowd out a formerly backed-off head indefinitely.
    sql`NOT EXISTS (
      SELECT 1
      FROM "onb_audit_anchor_outbox" AS lower_row
      WHERE lower_row."organization_id" = ${onbAuditAnchorOutbox.organizationId}
        AND lower_row."id" < ${onbAuditAnchorOutbox.id}
        AND lower_row."status" IN ('pending', 'failed', 'sending')
    )`,
  )).orderBy(asc(onbAuditAnchorOutbox.nextAttemptAt), asc(onbAuditAnchorOutbox.id)).limit(25);
  let delivered = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const row = await db.transaction(async (tx) => {
      // Claiming is the serialization boundary shared by all app instances.
      // The lower-id check is deliberately independent of due time: a later
      // operation cannot pass an older pending, failed, or stale-sending row.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`external-audit-anchor:${candidate.organizationId}`}))`);
      const [lowerUndelivered] = await tx.select({ id: onbAuditAnchorOutbox.id })
        .from(onbAuditAnchorOutbox)
        .where(and(
          eq(onbAuditAnchorOutbox.organizationId, candidate.organizationId),
          lt(onbAuditAnchorOutbox.id, candidate.id),
          or(
            eq(onbAuditAnchorOutbox.status, "pending"),
            eq(onbAuditAnchorOutbox.status, "failed"),
            eq(onbAuditAnchorOutbox.status, "sending"),
          ),
        ))
        .limit(1);
      if (lowerUndelivered) return null;
      const claimed = await tx.update(onbAuditAnchorOutbox).set({
        status: "sending",
        attempts: sql`${onbAuditAnchorOutbox.attempts} + 1`,
        // A crashed process becomes reclaimable after five minutes.
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
        lastError: null,
      }).where(and(
        eq(onbAuditAnchorOutbox.id, candidate.id),
        eq(onbAuditAnchorOutbox.organizationId, candidate.organizationId),
        or(eq(onbAuditAnchorOutbox.status, "pending"), eq(onbAuditAnchorOutbox.status, "failed"), eq(onbAuditAnchorOutbox.status, "sending")),
        lte(onbAuditAnchorOutbox.nextAttemptAt, now),
      )).returning();
      return claimed[0] ?? null;
    });
    if (!row) continue;

    try {
      const operation = operationFromOutbox(row);
      const existing = await db.select().from(onbAuditAnchorReceipts).where(and(
        eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
        eq(onbAuditAnchorReceipts.idempotencyKey, row.idempotencyKey),
        eq(onbAuditAnchorReceipts.providerId, activeProvider.id),
      ));
      const receipt = existing[0]
        ? {
            ...(existing[0].receipt as ExternalAnchorReceipt),
            receiptVersion: existing[0].receiptVersion,
            providerId: existing[0].providerId,
            providerKind: existing[0].providerKind as "simulated" | "external",
          }
        : await boundedProviderCall(
            activeProvider.anchor(operation),
            `audit anchor provider ${activeProvider.id}`,
          );
      const verified = receiptMatchesOperation(receipt, operation) &&
        await boundedProviderCall(
          activeProvider.verifyReceipt(receipt, operation),
          `audit anchor receipt verifier ${activeProvider.id}`,
        );
      if (!verified) throw new Error(`Provider receipt verification failed for ${row.id}`);

      let receiptRow = existing[0];
      if (!receiptRow) {
        const inserted = await db.insert(onbAuditAnchorReceipts).values({
          organizationId: row.organizationId,
          outboxId: row.id,
          idempotencyKey: row.idempotencyKey,
          providerId: receipt.providerId,
          providerKind: receipt.providerKind,
          receiptVersion: receipt.receiptVersion,
          checkpointSequence: receipt.checkpointSequence ?? null,
          checkpointHash: receipt.checkpointHash ?? null,
          receipt: receipt as unknown as Record<string, unknown>,
          verifiedAt: new Date(),
        }).onConflictDoNothing({
          target: [
            onbAuditAnchorReceipts.organizationId,
            onbAuditAnchorReceipts.idempotencyKey,
            onbAuditAnchorReceipts.providerId,
          ],
        }).returning();
        receiptRow = inserted[0] ?? (await db.select().from(onbAuditAnchorReceipts).where(and(
          eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
          eq(onbAuditAnchorReceipts.idempotencyKey, row.idempotencyKey),
          eq(onbAuditAnchorReceipts.providerId, activeProvider.id),
        )))[0];
      }
      const completed = await db.update(onbAuditAnchorOutbox).set({
        status: "delivered",
        receiptId: receiptRow?.id ?? null,
        deliveredAt: new Date(),
        nextAttemptAt: new Date(),
      }).where(and(
        eq(onbAuditAnchorOutbox.id, row.id),
        eq(onbAuditAnchorOutbox.organizationId, row.organizationId),
        eq(onbAuditAnchorOutbox.status, "sending"),
        eq(onbAuditAnchorOutbox.attempts, row.attempts),
      )).returning({ id: onbAuditAnchorOutbox.id });
      if (completed.length > 0) delivered += 1;
    } catch (error) {
      const failedUpdate = await db.update(onbAuditAnchorOutbox).set({
        status: "failed",
        lastError: String(error).slice(0, 500),
        nextAttemptAt: retryAt(row.attempts, now),
      }).where(and(
        eq(onbAuditAnchorOutbox.id, row.id),
        eq(onbAuditAnchorOutbox.organizationId, row.organizationId),
        eq(onbAuditAnchorOutbox.status, "sending"),
        eq(onbAuditAnchorOutbox.attempts, row.attempts),
      )).returning({ id: onbAuditAnchorOutbox.id });
      if (failedUpdate.length > 0) failed += 1;
      logger.warn({ organizationId: row.organizationId, outboxId: row.id }, "External audit anchor delivery failed; local audit remains authoritative and launch stays blocked");
    }
  }

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(onbAuditAnchorOutbox).where(
    and(
      options.organizationId ? eq(onbAuditAnchorOutbox.organizationId, options.organizationId) : undefined,
    or(eq(onbAuditAnchorOutbox.status, "pending"), eq(onbAuditAnchorOutbox.status, "failed"), eq(onbAuditAnchorOutbox.status, "sending")),
    ),
  );
  return { delivered, failed, remaining: Number(count) };
}

export type AnchorComparison = "empty" | "missing" | "match" | "external-behind" | "external-ahead" | "mismatch";

export function compareLocalAndExternalCheckpoint(
  local: { sequence: number; hash: string } | null,
  external: { sequence: number; hash: string } | null,
): AnchorComparison {
  if (!local) return "empty";
  if (!external) return "missing";
  if (external.sequence === local.sequence && external.hash === local.hash) return "match";
  if (external.sequence < local.sequence) return "external-behind";
  if (external.sequence > local.sequence) return "external-ahead";
  return "mismatch";
}

/**
 * Performs the restore-time comparison by querying the provider's current
 * independently held checkpoint. Local receipt rows are delivery evidence
 * only; they are never used as the provider's current truth.
 */
export async function externalAnchoringStatus(organizationId: string) {
  const [head] = await db.select().from(onbAuditHeads).where(eq(onbAuditHeads.organizationId, organizationId));
  let verified = false;
  let fetched: ExternalAnchorReceipt | null = null;
  if (activeProvider.independent || activeProvider.kind === "simulated") {
    try {
      fetched = await boundedProviderCall(
        activeProvider.fetchCurrentCheckpoint(organizationId),
        `audit anchor provider ${activeProvider.id} current checkpoint`,
      );
    } catch {
      fetched = null;
    }
  }
  if (fetched?.checkpointSequence !== undefined && fetched.checkpointHash !== undefined) {
    const operation: AuditAnchorOperation = {
      kind: "checkpoint",
      organizationId,
      idempotencyKey: fetched.idempotencyKey,
      sequence: fetched.checkpointSequence!,
      hash: fetched.checkpointHash!,
      retentionStatementPresent: fetched.retentionStatementPresent === true,
      legalHoldActive: fetched.legalHoldActive === true,
    };
    const receipt = fetched;
    try {
      verified = receiptMatchesOperation(receipt, operation) &&
        receipt.providerId === activeProvider.id &&
        receipt.providerKind === activeProvider.kind &&
        await boundedProviderCall(
          activeProvider.verifyReceipt(receipt, operation),
          `audit anchor receipt verifier ${activeProvider.id}`,
        );
    } catch {
      // A verifier outage is evidence of an unverified state, not a reason to
      // make local integrity review unavailable.
      verified = false;
    }
  }
  const comparison = compareLocalAndExternalCheckpoint(
    head && head.lastSequence > 0 ? { sequence: head.lastSequence, hash: head.lastHash } : null,
    fetched && fetched.checkpointSequence !== undefined && fetched.checkpointHash !== undefined
      ? { sequence: fetched.checkpointSequence, hash: fetched.checkpointHash }
      : null,
  );
  // Simulation is useful for delivery/retry tests but is never independent.
  const configured = activeProvider.kind === "external" &&
    activeProvider.independent &&
    verified &&
    comparison === "match";
  return {
    requiredForLaunch: true as const,
    providerId: activeProvider.id,
    providerKind: activeProvider.kind,
    configured,
    verified,
    comparison,
    latestSequence: fetched?.checkpointSequence ?? null,
    latestReceiptAt: fetched?.issuedAt ?? null,
    regulatedProductionLaunchBlocked: !configured || comparison !== "match",
    limitation: configured
      ? "Configured only after an independently operated provider receipt is cryptographically verified; restore checks compare the local head with that receipt."
      : "Simulation receipts exercise delivery and verification but are not independent protection. Outages leave local audit authoritative, queue delivery for retry, and keep regulated production blocked.",
    recommendedOutageBehavior: "Continue local append-only capture, retry the durable outbox with idempotency, alert reviewers, and do not claim regulated protection until verification and local/external comparison recover.",
  };
}