import { createHash } from "node:crypto";
import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import {
  db,
  onbAuditAnchorOutbox,
  onbAuditAnchorReceipts,
  onbAuditHeads,
} from "@workspace/db";
import { logger } from "../logger";
import {
  acquireExternalAuditArchiveLock,
  getExternalAuditArchiveDrills,
  getExternalAuditArchiveSnapshot,
  getExternalAuditArchiveSnapshotInTransaction,
  recordExternalAuditArchiveDrill,
  type ExternalAuditArchiveDrillKind,
  type ExternalAuditArchiveDrillReceipt,
  type ExternalAuditArchiveSnapshot,
  type OnboardingDbTransaction,
} from "./settings";

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
  configGeneration: number;
  archiveNamespace: string;
  checkpointSequence?: number;
  checkpointHash?: string;
  legalHoldActive?: boolean;
  retentionStatementPresent?: boolean;
  reasonFingerprint?: string;
  proof: string;
  issuedAt: string;
};

export type ExternalAuditAnchorContext = {
  organizationId: string;
  providerId: string;
  archiveNamespace: string;
  credentialSecretReferenceName: string;
  configGeneration: number;
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
  anchor(operation: AuditAnchorOperation, context: ExternalAuditAnchorContext): Promise<ExternalAnchorReceipt>;
  verifyReceipt(receipt: ExternalAnchorReceipt, operation: AuditAnchorOperation, context: ExternalAuditAnchorContext): Promise<boolean>;
  /** Reads the provider's current independently held checkpoint, not local DB state. */
  fetchCurrentCheckpoint(organizationId: string, context: ExternalAuditAnchorContext): Promise<ExternalAnchorReceipt | null>;
  runRestoreDrill?(context: ExternalAuditAnchorContext): Promise<ExternalAuditDrillReceipt>;
  runLegalHoldDrill?(context: ExternalAuditAnchorContext): Promise<ExternalAuditDrillReceipt>;
  verifyDrillReceipt?(receipt: ExternalAuditDrillReceipt, context: ExternalAuditAnchorContext): Promise<boolean>;
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
  async anchor(operation, context) {
    const receipt = {
      receiptVersion: 1,
      providerId: this.id,
      providerKind: this.kind,
      operationKind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      organizationId: operation.organizationId,
      configGeneration: context.configGeneration,
      archiveNamespace: context.archiveNamespace,
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
  async verifyReceipt(receipt, operation, context) {
    return receipt.providerId === this.id &&
      receipt.providerKind === this.kind &&
      receipt.configGeneration === context.configGeneration &&
      receipt.archiveNamespace === context.archiveNamespace &&
      receipt.proof === simulationProof(operation);
  },
  async fetchCurrentCheckpoint(organizationId, context) {
    const receipt = simulationCheckpoints.get(organizationId) ?? null;
    return receipt &&
      receipt.configGeneration === context.configGeneration &&
      receipt.archiveNamespace === context.archiveNamespace
      ? receipt
      : null;
  },
};

const providerRegistry = new Map<string, ExternalAuditAnchorProvider>();
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
  providerRegistry.set(provider.id, provider);
}

export function resetExternalAuditAnchorProviderForTests(): void {
  providerRegistry.clear();
  simulationCheckpoints.clear();
  simulationLegalHolds.clear();
}

export function legalHoldReasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason.trim().slice(0, 2_000)).digest("hex").slice(0, 32);
}

export function currentExternalAuditAnchorProvider(): Pick<ExternalAuditAnchorProvider, "id" | "kind" | "independent"> {
  return simulationProvider;
}

export type ExternalAuditAnchorResolution = ExternalAuditArchiveSnapshot & {
  provider: ExternalAuditAnchorProvider | null;
  providerAvailable: boolean;
  context: ExternalAuditAnchorContext;
};

function externalAuditAnchorResolutionFromSnapshot(
  organizationId: string,
  snapshot: ExternalAuditArchiveSnapshot,
): ExternalAuditAnchorResolution {
  const provider = snapshot.config
    ? providerRegistry.get(snapshot.config.providerId) ?? null
    : simulationProvider;
  return {
    config: snapshot.config,
    generation: snapshot.generation,
    head: snapshot.head,
    provider,
    providerAvailable: provider !== null,
    context: {
      organizationId,
      providerId: snapshot.config?.providerId ?? provider?.id ?? simulationProvider.id,
      archiveNamespace: snapshot.config?.archiveNamespace ?? "",
      credentialSecretReferenceName: snapshot.config?.credentialSecretReferenceName ?? "",
      configGeneration: snapshot.generation,
    },
  };
}

async function resolveExternalAuditAnchorInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
): Promise<ExternalAuditAnchorResolution> {
  return externalAuditAnchorResolutionFromSnapshot(
    organizationId,
    await getExternalAuditArchiveSnapshotInTransaction(tx, organizationId),
  );
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

function providerContextFingerprint(context: ExternalAuditAnchorContext): string {
  return createHash("sha256").update(stable({
    providerId: context.providerId,
    archiveNamespace: context.archiveNamespace,
    credentialSecretReferenceName: context.credentialSecretReferenceName,
  })).digest("hex").slice(0, 32);
}

function operationForProvider(
  operation: AuditAnchorOperation,
  context: ExternalAuditAnchorContext,
): AuditAnchorOperation {
  return {
    ...operation,
    idempotencyKey: `${operation.idempotencyKey}:g${context.configGeneration}:ctx${providerContextFingerprint(context)}`,
  };
}

function retryAt(attempts: number, now: Date): Date {
  const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 9));
  return new Date(now.getTime() + delay);
}

function receiptMatchesOperation(
  receipt: ExternalAnchorReceipt,
  operation: AuditAnchorOperation,
  context: ExternalAuditAnchorContext,
): boolean {
  if (
    receipt.operationKind !== operation.kind ||
    receipt.organizationId !== operation.organizationId ||
    receipt.idempotencyKey !== operation.idempotencyKey ||
    receipt.providerId !== context.providerId ||
    receipt.configGeneration !== context.configGeneration ||
    receipt.archiveNamespace !== context.archiveNamespace
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
  timeoutMs = PROVIDER_CALL_TIMEOUT_MS,
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
    const resolution = await resolveExternalAuditAnchor(row.organizationId);
    const provider = resolution.provider;
    if (!provider) {
      await db.update(onbAuditAnchorOutbox).set({
        status: "pending",
        nextAttemptAt: now,
        lastError: `missing-provider-adapter:${resolution.context.providerId}`,
        deliveredAt: null,
        receiptId: null,
      }).where(and(
        eq(onbAuditAnchorOutbox.id, row.id),
        eq(onbAuditAnchorOutbox.organizationId, row.organizationId),
        eq(onbAuditAnchorOutbox.status, "delivered"),
      ));
      continue;
    }
    await db.transaction(async (tx) => {
      // This lock covers both provider-transition requeueing and claims. It
      // is intentionally held only for the database transition; provider
      // calls happen after the claim commits so stale-claim fencing remains
      // observable and recoverable by another instance.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`external-audit-anchor:${row.organizationId}`}))`);
      const operation = operationForProvider(operationFromOutbox(row), resolution.context);
      const [providerReceipt] = await tx.select({
        id: onbAuditAnchorReceipts.id,
        receipt: onbAuditAnchorReceipts.receipt,
      })
        .from(onbAuditAnchorReceipts)
        .where(and(
          eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
          eq(onbAuditAnchorReceipts.idempotencyKey, operation.idempotencyKey),
          eq(onbAuditAnchorReceipts.providerId, provider.id),
          eq(onbAuditAnchorReceipts.configGeneration, resolution.generation),
        ))
        .limit(1);
      if (!providerReceipt) {
        await tx.update(onbAuditAnchorOutbox).set({
          status: "pending",
          nextAttemptAt: now,
           lastError: `provider-transition-reanchor:${provider.id}`,
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
      const completed = await db.transaction(async (tx) => {
        // Hold the archive lock across final resolution, provider invocation,
        // verification, and evidence persistence. Config replacement therefore
        // cannot complete between choosing a context and remote dispatch.
        await acquireExternalAuditArchiveLock(tx, row.organizationId);
        const resolution = await resolveExternalAuditAnchorInTransaction(tx, row.organizationId);
        if (!resolution.provider) {
          await tx.update(onbAuditAnchorOutbox).set({
            status: "failed",
            lastError: `missing-provider-adapter:${resolution.context.providerId}`,
            nextAttemptAt: retryAt(row.attempts, now),
          }).where(and(
            eq(onbAuditAnchorOutbox.id, row.id),
            eq(onbAuditAnchorOutbox.organizationId, row.organizationId),
            eq(onbAuditAnchorOutbox.status, "sending"),
            eq(onbAuditAnchorOutbox.attempts, row.attempts),
          ));
          return { delivered: false, missingProvider: true };
        }
        const provider = resolution.provider;
        const operation = operationForProvider(operationFromOutbox(row), resolution.context);
        const existing = await tx.select().from(onbAuditAnchorReceipts).where(and(
          eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
          eq(onbAuditAnchorReceipts.idempotencyKey, operation.idempotencyKey),
          eq(onbAuditAnchorReceipts.providerId, provider.id),
          eq(onbAuditAnchorReceipts.configGeneration, resolution.generation),
        ));
        const receipt = existing[0]
          ? {
              ...(existing[0].receipt as ExternalAnchorReceipt),
              receiptVersion: existing[0].receiptVersion,
              providerId: existing[0].providerId,
              providerKind: existing[0].providerKind as "simulated" | "external",
              configGeneration: existing[0].configGeneration,
            }
          : await boundedProviderCall(
              provider.anchor(operation, resolution.context),
              `audit anchor provider ${provider.id}`,
              provider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
            );
        const verified = receiptMatchesOperation(receipt, operation, resolution.context) &&
          await boundedProviderCall(
            provider.verifyReceipt(receipt, operation, resolution.context),
            `audit anchor receipt verifier ${provider.id}`,
            provider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
          );
        if (!verified) throw new Error(`Provider receipt verification failed for ${row.id}`);

        let receiptRow = existing[0];
        if (!receiptRow) {
          const inserted = await tx.insert(onbAuditAnchorReceipts).values({
            organizationId: row.organizationId,
            outboxId: row.id,
            idempotencyKey: receipt.idempotencyKey,
            providerId: receipt.providerId,
            configGeneration: receipt.configGeneration,
            providerKind: receipt.providerKind,
            receiptVersion: receipt.receiptVersion,
            checkpointSequence: receipt.checkpointSequence ?? null,
            checkpointHash: receipt.checkpointHash ?? null,
            receipt: {
              ...(receipt as unknown as Record<string, unknown>),
            },
            verifiedAt: new Date(),
          }).onConflictDoNothing({
            target: [
              onbAuditAnchorReceipts.organizationId,
              onbAuditAnchorReceipts.idempotencyKey,
              onbAuditAnchorReceipts.providerId,
              onbAuditAnchorReceipts.configGeneration,
            ],
          }).returning();
          receiptRow = inserted[0] ?? (await tx.select().from(onbAuditAnchorReceipts).where(and(
            eq(onbAuditAnchorReceipts.organizationId, row.organizationId),
            eq(onbAuditAnchorReceipts.idempotencyKey, operation.idempotencyKey),
            eq(onbAuditAnchorReceipts.providerId, provider.id),
            eq(onbAuditAnchorReceipts.configGeneration, resolution.generation),
          )))[0];
        }
        const updated = await tx.update(onbAuditAnchorOutbox).set({
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
        return { delivered: updated.length > 0, missingProvider: false };
      });
      if (completed.delivered) delivered += 1;
      if (completed.missingProvider) failed += 1;
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

/**
 * This is deliberately a small public-safe health shape. In particular it
 * never carries a provider id, receipt, outbox id/key, checkpoint hash, or
 * provider error text. It is suitable for reviewer alerts and health UI.
 */
export type ExternalAuditAnchorSafeStatus = {
  delivery: "clear" | "backlog";
  providerRead: "not-applicable" | "ok" | "failed";
  receiptVerification: "not-applicable" | "ok" | "failed";
};

export type ExternalAuditAnchorReviewerFault =
  | "delivery-backlog"
  | "provider-read-failed"
  | "receipt-verification-failed";

/**
 * Read a provider's independent checkpoint only when an independent provider
 * is configured. A normal, empty remote checkpoint is a successful read, not
 * a provider outage; launch readiness remains fail-closed separately.
 */
export async function externalAuditAnchorSafeStatus(
  organizationId: string,
): Promise<ExternalAuditAnchorSafeStatus> {
  const resolution = await resolveExternalAuditAnchor(organizationId);
  const { config, provider, context } = resolution;
  const [undelivered] = await db
    .select({ id: onbAuditAnchorOutbox.id })
    .from(onbAuditAnchorOutbox)
    .where(and(
      eq(onbAuditAnchorOutbox.organizationId, organizationId),
      or(
        eq(onbAuditAnchorOutbox.status, "pending"),
        eq(onbAuditAnchorOutbox.status, "sending"),
        eq(onbAuditAnchorOutbox.status, "failed"),
      ),
    ))
    .limit(1);

  const status: ExternalAuditAnchorSafeStatus = {
    delivery: undelivered ? "backlog" : "clear",
    providerRead: "not-applicable",
    receiptVerification: "not-applicable",
  };
  // The bundled simulation intentionally cannot represent an independent
  // provider outage. It remains launch-blocking but must not page reviewers.
  // The bundled simulation and a configured-but-unregistered provider are
  // unavailable for independent reviewer health. The latter must not silently
  // fall back to simulation.
  if (
    !provider ||
    (config && provider.id !== config.providerId) ||
    provider.kind !== "external" ||
    !provider.independent
  ) return status;
  const [head] = await db.select({
    lastSequence: onbAuditHeads.lastSequence,
    lastHash: onbAuditHeads.lastHash,
  }).from(onbAuditHeads).where(eq(onbAuditHeads.organizationId, organizationId));
  const local = head && head.lastSequence > 0 && head.lastHash
    ? { sequence: head.lastSequence, hash: head.lastHash }
    : null;

  let receipt: ExternalAnchorReceipt | null;
  try {
    receipt = await boundedProviderCall(
      provider.fetchCurrentCheckpoint(organizationId, context),
      "audit anchor provider current checkpoint",
    );
    status.providerRead = "ok";
  } catch {
    status.providerRead = "failed";
    return status;
  }
  // An empty provider is only acceptable when local audit capture is empty.
  if (!receipt) {
    if (local) status.receiptVerification = "failed";
    return status;
  }

  // A current-checkpoint result must be a checkpoint receipt. Do not expose
  // malformed provider material in a notification or status response.
  if (
    receipt.checkpointSequence === undefined ||
    receipt.checkpointHash === undefined ||
    !Number.isSafeInteger(receipt.checkpointSequence) ||
    receipt.checkpointSequence <= 0 ||
    !receipt.checkpointHash ||
    receipt.providerId !== provider.id ||
    receipt.providerKind !== provider.kind ||
    receipt.operationKind !== "checkpoint" ||
    receipt.organizationId !== organizationId
  ) {
    status.receiptVerification = "failed";
    return status;
  }
  const operation: AuditAnchorOperation = {
    kind: "checkpoint",
    organizationId,
    idempotencyKey: receipt.idempotencyKey,
    sequence: receipt.checkpointSequence,
    hash: receipt.checkpointHash,
    retentionStatementPresent: receipt.retentionStatementPresent === true,
    legalHoldActive: receipt.legalHoldActive === true,
  };
  try {
    status.receiptVerification =
      receiptMatchesOperation(receipt, operation, context) &&
      await boundedProviderCall(
        provider.verifyReceipt(receipt, operation, context),
        "audit anchor receipt verifier",
      )
        ? "ok"
        : "failed";
  } catch {
    status.receiptVerification = "failed";
  }
  // A cryptographically valid receipt is not enough: this provider checkpoint
  // must still be exactly the independently held counterpart of local truth.
  if (
    status.receiptVerification === "ok" &&
    compareLocalAndExternalCheckpoint(local, {
      sequence: receipt.checkpointSequence,
      hash: receipt.checkpointHash,
    }) !== "match"
  ) status.receiptVerification = "failed";
  return status;
}

export function externalAuditAnchorReviewerFaults(
  status: ExternalAuditAnchorSafeStatus,
): ExternalAuditAnchorReviewerFault[] {
  const faults: ExternalAuditAnchorReviewerFault[] = [];
  if (status.delivery === "backlog") faults.push("delivery-backlog");
  if (status.providerRead === "failed") faults.push("provider-read-failed");
  if (status.receiptVerification === "failed") faults.push("receipt-verification-failed");
  return faults;
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
 * Runs a provider-owned drill and records its complete non-secret signed
 * receipt. A caller cannot mark a drill passed without an adapter response and
 * its cryptographic verifier.
 */
export async function runExternalAuditArchiveDrill(
  organizationId: string,
  kind: ExternalAuditArchiveDrillKind,
): Promise<{ kind: ExternalAuditArchiveDrillKind; providerId: string; passed: boolean }> {
  const resolution = await resolveExternalAuditAnchor(organizationId);
  const { config, provider, context } = resolution;
  if (!config || !provider || provider.kind !== "external" || !provider.independent || provider.id !== config.providerId) {
    throw new Error("An independently registered provider configuration is required before running an archive drill.");
  }
  const run = kind === "restore" ? provider.runRestoreDrill : provider.runLegalHoldDrill;
  if (!run || !provider.verifyDrillReceipt) {
    throw new Error(`Provider ${provider.id} does not expose a cryptographically verifiable ${kind} drill.`);
  }
  const receipt = await boundedProviderCall(
    run.call(provider, context),
    `audit archive ${kind} drill ${provider.id}`,
    provider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
  );
  const passed = receipt.providerId === provider.id &&
    receipt.organizationId === organizationId &&
    receipt.configGeneration === resolution.generation &&
    receipt.archiveNamespace === config.archiveNamespace &&
    receipt.kind === kind &&
    receipt.passed &&
    await boundedProviderCall(
      provider.verifyDrillReceipt(receipt, context),
      `audit archive ${kind} drill verifier ${provider.id}`,
      provider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
    );
  if (!passed) throw new Error(`Provider ${provider.id} returned an unverifiable ${kind} drill receipt.`);
  await recordExternalAuditArchiveDrill(organizationId, {
    kind,
    providerId: provider.id,
    configGeneration: resolution.generation,
    receipt,
    recordedAt: new Date().toISOString(),
  });
  return { kind, providerId: provider.id, passed: true };
}
/**
 * Performs the restore-time comparison by querying the provider's current
 * independently held checkpoint. Local receipt rows are delivery evidence
 * only; they are never used as the provider's current truth.
 */
export async function externalAnchoringStatus(organizationId: string) {
  const resolution = await resolveExternalAuditAnchor(organizationId);
  const { config, provider: configuredProvider, context } = resolution;
  const head = resolution.head;
  let drills: Awaited<ReturnType<typeof getExternalAuditArchiveDrills>> = [];
  let drillsInvalid = false;
  try {
    drills = await getExternalAuditArchiveDrills(organizationId);
  } catch {
    // Malformed local evidence is fail-closed and remains launch-blocking.
    drillsInvalid = true;
  }
  let restoreDrillPassed = false;
  let legalHoldDrillPassed = false;
  if (config && configuredProvider && configuredProvider.id === config.providerId && configuredProvider.verifyDrillReceipt) {
    for (const drill of drills) {
      if (
        drill.providerId !== config.providerId ||
        drill.configGeneration !== resolution.generation ||
        drill.receipt.providerId !== config.providerId ||
        drill.receipt.organizationId !== organizationId ||
        drill.receipt.configGeneration !== resolution.generation ||
        drill.receipt.archiveNamespace !== config.archiveNamespace ||
        drill.receipt.kind !== drill.kind ||
        drill.receipt.passed !== true
      ) continue;
      try {
        const verifiedDrill = await boundedProviderCall(
          configuredProvider.verifyDrillReceipt(drill.receipt, context),
          `audit archive ${drill.kind} drill verifier ${configuredProvider.id}`,
          configuredProvider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
        );
        if (verifiedDrill && drill.kind === "restore") restoreDrillPassed = true;
        if (verifiedDrill && drill.kind === "legal_hold") legalHoldDrillPassed = true;
      } catch {
        // Provider verification outage or signature failure remains blocked.
      }
    }
  }
  let verified = false;
  let fetched: ExternalAnchorReceipt | null = null;
  if (configuredProvider && (configuredProvider.independent || configuredProvider.kind === "simulated")) {
    try {
      fetched = await boundedProviderCall(
        configuredProvider.fetchCurrentCheckpoint(organizationId, context),
        `audit anchor provider ${configuredProvider.id} current checkpoint`,
        configuredProvider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
      );
    } catch {
      fetched = null;
    }
  }
  if (configuredProvider && fetched?.checkpointSequence !== undefined && fetched.checkpointHash !== undefined) {
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
      verified = receiptMatchesOperation(receipt, operation, context) &&
        receipt.providerId === configuredProvider.id &&
        receipt.providerKind === configuredProvider.kind &&
        await boundedProviderCall(
          configuredProvider.verifyReceipt(receipt, operation, context),
          `audit anchor receipt verifier ${configuredProvider.id}`,
          configuredProvider.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS,
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
  const finalSnapshot = await getExternalAuditArchiveSnapshot(organizationId);
  const staleSnapshot =
    finalSnapshot.generation !== resolution.generation ||
    finalSnapshot.head?.lastSequence !== head?.lastSequence ||
    finalSnapshot.head?.lastHash !== head?.lastHash;
  // Simulation is useful for delivery/retry tests but is never independent.
  const configured = !staleSnapshot && Boolean(config) &&
    configuredProvider?.kind === "external" &&
    configuredProvider.independent &&
    verified &&
    comparison === "match" &&
    !drillsInvalid &&
    restoreDrillPassed &&
    legalHoldDrillPassed;
  return {
    requiredForLaunch: true as const,
    providerId: configuredProvider?.id ?? config?.providerId ?? "simulation",
    configuredProviderId: config?.providerId ?? null,
    configGeneration: resolution.generation,
    providerKind: (configuredProvider?.kind ?? "unavailable") as "simulated" | "external" | "unavailable",
    archiveNamespace: config?.archiveNamespace ?? null,
    retentionPolicyStatementOrReference: config?.retentionPolicyStatementOrReference ?? null,
    independentAdministratorContact: config?.independentAdministratorContact ?? null,
    independentAdministratorRole: config?.independentAdministratorRole ?? null,
    credentialSecretReferenceNameConfigured: Boolean(config?.credentialSecretReferenceName),
    configured,
    verified,
    comparison,
    restoreDrillPassed,
    legalHoldDrillPassed,
    drillsInvalid,
    staleSnapshot,
    latestSequence: fetched?.checkpointSequence ?? null,
    latestReceiptAt: fetched?.issuedAt ?? null,
    regulatedProductionLaunchBlocked: !configured || comparison !== "match",
    limitation: configured
      ? "Configured only after an independently operated provider receipt is cryptographically verified and restore/legal-hold drills are recorded passed against that provider."
      : staleSnapshot
        ? "Tenant audit head or archive configuration changed while provider verification was in flight; the status is fenced and must be recomputed."
        : !configuredProvider
          ? `Configured provider ${config?.providerId ?? "unknown"} is not registered; delivery remains retryable and regulated launch stays blocked.`
          : "No provider is preselected. Simulation receipts exercise delivery and verification but are not independent protection; both provider drills must have fresh provider verification and remain required for regulated launch.",
    recommendedOutageBehavior: "Continue local append-only capture, retry the durable outbox with idempotency, alert reviewers, and do not claim regulated protection until verification and local/external comparison recover.",
  };
}

/** Resolve config, generation, adapter, and context from one fenced snapshot. */
export async function resolveExternalAuditAnchor(
  organizationId: string,
): Promise<ExternalAuditAnchorResolution> {
  return externalAuditAnchorResolutionFromSnapshot(
    organizationId,
    await getExternalAuditArchiveSnapshot(organizationId),
  );
}

/** Compatibility helper; dispatch paths use resolveExternalAuditAnchor. */
export async function resolveExternalAuditAnchorProvider(
  organizationId: string,
): Promise<ExternalAuditAnchorProvider> {
  const provider = (await resolveExternalAuditAnchor(organizationId)).provider;
  if (!provider) throw new Error("Configured external audit provider is not registered.");
  return provider;
}

export type ExternalAuditDrillReceipt = ExternalAuditArchiveDrillReceipt;
