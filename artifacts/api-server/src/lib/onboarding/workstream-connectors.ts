import { db, onbCases } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { type OnbChecklistTemplateItem, type OnbReadinessItemRow } from "@workspace/db/schema";
import {
  documentPackFor,
  seedDocumentsForCase,
  type DocumentSeedCase,
} from "./documents";
import {
  applicableSystems,
  isNonEmployee,
  type WatchedSystem,
} from "./external-systems";
import {
  deriveRequiredBranches,
  hashApprovalProposal,
  type ApprovalDecision,
  type ApprovalProposal,
  type ExecutableActionBinding,
  type PlanBranch,
} from "./compound-action-contract";
import {
  ConnectorDispatchRejectedError,
  createConnectorProposal,
  dispatchConnectorMutation,
  type ConnectorMutation,
} from "./connector-adapters";
import { trackCaseSystems } from "./system-watcher";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { withCaseDispatchGuard } from "./dispatch-guard";
import { evaluateWorkforceRuntimePrerequisites } from "./operational-requests";
import { workforceRuntimeEnabled } from "./workforce-step-runtime";
import { checklistStageBlockers } from "./settings";
import {
  resolveCurrentCaseExecutionAuthorityEvidence,
  verifyCurrentCompoundAuthorities,
} from "./decision-authority";
import {
  claimEffectDispatch,
  confirmEffect,
  ensureEffectJournalEntry,
  isConfirmedEffect,
  markAmbiguousEffectForManualRepair,
} from "./effect-journal";
import type { OnboardingDbTransaction } from "./settings";
import { evaluateStoredCaseGovernanceGate } from "./governance-runtime";
import { withGovernanceDispatch } from "./governance-dispatch";
type CaseRow = typeof onbCases.$inferSelect;

export type WorkstreamConnectorCase = Pick<
  CaseRow,
  | "id"
  | "organizationId"
  | "workerEmail"
  | "workerCategory"
  | "hireType"
  | "geography"
  | "legalEntity"
  | "lifecycleStage"
  | "recruiterName"
  | "createdByUserId"
  | "updatedAt"
  | "workstreams"
> & {
  offerAcceptanceComplete?: boolean;
  workerName?: string;
  workerPhone?: string | null;
  notes?: string | null;
  checklistSnapshot?: OnbChecklistTemplateItem[];
  readiness?: OnbReadinessItemRow[];
  orchestrationStatus?: string;
  checklistTemplateVersion?: number;
  checklistProfileId?: string | null;
  checklistProfileVersion?: number | null;
  workforceContextVersion?: number;
  processPolicySnapshot?: unknown;
};

type DispatchAuthorization = {
  binding: ExecutableActionBinding;
  decisions: ApprovalDecision[];
};

export type WorkstreamConnectorDependencies = {
  authorize?: (
    proposal: ApprovalProposal,
    mutation: ConnectorMutation,
  ) => DispatchAuthorization | Promise<DispatchAuthorization>;
  write?: (
    mutation: Readonly<ConnectorMutation>,
    c: WorkstreamConnectorCase,
  ) => Promise<void>;
  now?: () => Date;
  /** Deterministic test/simulator authority source; production reads current DB state. */
  verifyCurrentAuthority?: (input: {
    proposal: ApprovalProposal;
    decisions: ApprovalDecision[];
  }) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  withAuthorityFence?: <T>(
    write: (tx?: OnboardingDbTransaction) => Promise<T>,
  ) => Promise<T>;
  /** Immutable authenticated principal IDs, used for live SoD checks. */
  actorUserIds?: {
    requestor?: string;
    beneficiary?: string;
    executor?: string;
  };
};

function isOrdinaryExecutionMutation(mutation: ConnectorMutation): boolean {
  return (
    (mutation.connector === "payroll" && mutation.operation === "enrol-worker") ||
    (mutation.connector === "iam" && mutation.operation === "provision-account") ||
    (mutation.connector === "background-verification" && mutation.operation === "open-check") ||
    (mutation.connector === "documents" && mutation.operation === "send-envelope")
  );
}
function requiredBranches(c: WorkstreamConnectorCase): PlanBranch[] {
  const nonEmployee = isNonEmployee(c.workerCategory);
  const workerType =
    c.workerCategory === "intern"
      ? "intern"
      : c.workerCategory === "contractor"
        ? "contractor"
        : c.workerCategory === "vendor"
          ? "vendor"
          : "employee";
  const result = deriveRequiredBranches({
    workerType,
    paidIntern: c.workerCategory === "intern",
    requiresBgv: c.hireType !== "internal-transfer",
    requiresPayroll: !nonEmployee,
    requiresAccess: true,
    requiresAssets: true,
    requiresLearning: true,
    subjectSource:
      workerType === "contractor"
        ? "authorized-contractor-registry"
        : workerType === "vendor"
          ? "authorized-vendor-registry"
          : "HRIS",
  });
  if (!result.accepted) {
    throw new Error(`Connector applicability rejected: ${result.reason}`);
  }
  return result.branches;
}

function blockersFor(
  c: WorkstreamConnectorCase,
  mutation: Pick<ConnectorMutation, "connector">,
): string[] {
  // Workstream-owned status is not a global connector deny-list. In
  // particular, incomplete asset and learning human tasks must not reject a
  // previously safe documents/BGV/IAM/payroll operation. Global policy
  // evidence remains enforced independently by workstreamPolicyGateOpen().
  const workstreamKey =
    mutation.connector === "documents" || mutation.connector === "background-verification"
      ? "documentation"
      : mutation.connector === "iam"
        ? "access"
        : mutation.connector === "payroll"
          ? "payroll"
          : null;
  if (!workstreamKey) return [];
  return (c.workstreams as Array<{ key?: string; blockers?: string[] }>)
    .filter((workstream) => workstream.key === workstreamKey)
    .flatMap((workstream) => workstream.blockers ?? []);
}

/** Rechecked at recovery and immediately before each connector operation. */
export function workstreamPolicyGateOpen(c: WorkstreamConnectorCase): boolean {
  // Only legacy narrow unit callers which omit the column entirely may
  // proceed. A persisted empty snapshot is unsafe/unknown and fails closed.
  if (c.checklistSnapshot === undefined || c.readiness === undefined) return true;
  // Empty persisted snapshots are legacy only when the v2 workforce runtime
  // is not enabled. A v2 policy with no gates is an unsafe/corrupt snapshot.
  if (c.checklistSnapshot.length === 0) {
    return !workforceRuntimeEnabled((c.processPolicySnapshot ?? {}) as Record<string, unknown>);
  }
  return checklistStageBlockers({
    checklistSnapshot: c.checklistSnapshot,
    readiness: c.readiness,
  }, "before-workstreams").length === 0;
}

/** Payroll is the only connector mutation gated by its human runtime tasks. */
async function mutationMayDispatch(
  c: WorkstreamConnectorCase,
  mutation: ConnectorMutation,
): Promise<boolean> {
  if (
    mutation.connector !== "payroll" ||
    !workforceRuntimeEnabled((c.processPolicySnapshot ?? {}) as Record<string, unknown>)
  ) return true;
  const runtime = await evaluateWorkforceRuntimePrerequisites({
    organizationId: c.organizationId,
    caseId: c.id,
    workstream: "payroll",
  });
  // A v2 payroll mutation is fail-closed until persisted human tasks exist
  // and every blocking task is complete. This is intentionally not a
  // workstream-wide decision: documents, BGV, and IAM remain independently
  // dispatchable through their own guarded journal operations.
  return runtime.active && runtime.allowed;
}

/** Read-only recovery fence for payroll human prerequisites. */

function proposalFor(
  c: WorkstreamConnectorCase,
  mutation: ConnectorMutation,
  branches: PlanBranch[],
): ApprovalProposal {
  return createConnectorProposal({
    mutation,
    tenantId: c.organizationId,
    caseId: String(c.id),
    planVersion: c.checklistTemplateVersion ?? 1,
    requiredBranchSet: branches,
    logicalOperationKey: `${c.organizationId}:${c.id}:${mutation.connector}:${mutation.operation}`,
    policyVersion: "onboarding-runtime-v1",
    evidenceRefs: [`case:${c.id}:context:${c.workforceContextVersion ?? 1}:profile:${c.checklistProfileId ?? "default"}:${c.checklistProfileVersion ?? c.checklistTemplateVersion ?? 1}`],
  });
}

function systemForMutation(
  mutation: Readonly<ConnectorMutation>,
): WatchedSystem | undefined {
  if (
    mutation.connector === "background-verification" &&
    mutation.operation === "open-check"
  ) {
    return "bgv";
  }
  if (mutation.connector === "iam" && mutation.operation === "provision-account") {
    return "itsm";
  }
  if (mutation.connector === "payroll" && mutation.operation === "enrol-worker") {
    return "payroll";
  }
  return undefined;
}

function documentSeedFrom(
  payload: Readonly<ConnectorMutation>["payload"],
  organizationId: string,
): DocumentSeedCase {
  if (
    payload === null ||
    Array.isArray(payload) ||
    typeof payload !== "object" ||
    typeof payload.caseId !== "number" ||
    typeof payload.workerCategory !== "string" ||
    typeof payload.geography !== "string" ||
    typeof payload.hireType !== "string"
  ) {
    throw new Error("Approved document payload is incomplete");
  }
  return {
    id: payload.caseId,
    organizationId,
    workerCategory: payload.workerCategory,
    geography: payload.geography,
    hireType: payload.hireType,
    // The document pack itself is snapshotted in the proposal. Lifecycle is
    // deliberately not an effect input: retry after promotion must reuse the
    // same logical document operation instead of producing a hash conflict.
    lifecycleStage: "preboarding",
  };
}

async function productionWrite(
  mutation: Readonly<ConnectorMutation>,
  _c: WorkstreamConnectorCase,
  tx?: OnboardingDbTransaction,
): Promise<void> {
  if (
    mutation.connector === "documents" &&
    mutation.operation === "send-envelope"
  ) {
    await seedDocumentsForCase(documentSeedFrom(mutation.payload, _c.organizationId));
    return;
  }
  const system = systemForMutation(mutation);
  if (!system) {
    throw new Error(
      `No production writer for ${mutation.connector}:${mutation.operation}`,
    );
  }
  const payload = mutation.payload as { caseId: number; system: WatchedSystem };
  if (payload.system !== system) {
    throw new Error(
      `Approved system ${payload.system} does not match ${mutation.connector}:${mutation.operation}`,
    );
  }
  await trackCaseSystems(payload.caseId, [system], tx);
}

/**
 * A legacy writer has no remote receipt to query, so it still gets a durable
 * logical-effect record. Confirmed keys are intentionally reused rather than
 * replayed; an ambiguous outcome is surfaced for manual repair.
 */
async function journaledProductionWrite(input: {
  mutation: Readonly<ConnectorMutation>;
  c: WorkstreamConnectorCase;
  proposal: ApprovalProposal;
  tx?: OnboardingDbTransaction;
}): Promise<void> {
  const identity = {
    logicalOperationKey: input.proposal.logicalOperationKey,
    organizationId: input.c.organizationId,
    tenantId: input.c.organizationId,
    caseId: input.c.id,
    toolName: input.proposal.toolName,
    argumentsHash: hashApprovalProposal(input.proposal),
    // The legacy DB writers are deterministic/idempotent for this logical key.
    providerIdempotency: true,
  };
  const entry = await ensureEffectJournalEntry(identity);
  const claim = await claimEffectDispatch({
    ...identity,
    owner: `workstream-writer:${input.proposal.logicalOperationKey}`,
    expectedFencingToken: entry.fencingToken,
  });
  if (claim.kind === "reuse_confirmed") return;
  if (claim.kind === "manual_repair_required") {
    throw new Error("Effect requires manual repair before another provider dispatch");
  }
  if (claim.kind !== "claimed") {
    throw new Error("Effect is already being dispatched by another worker");
  }
  try {
    await productionWrite(input.mutation, input.c, input.tx);
    if (!(await confirmEffect({
      logicalOperationKey: identity.logicalOperationKey,
      organizationId: identity.organizationId,
      owner: `workstream-writer:${input.proposal.logicalOperationKey}`,
      fencingToken: claim.fencingToken,
    }))) {
      throw new Error("Effect confirmation was fenced by another worker");
    }
  } catch (error) {
    await markAmbiguousEffectForManualRepair({
      logicalOperationKey: identity.logicalOperationKey,
      organizationId: identity.organizationId,
      owner: `workstream-writer:${input.proposal.logicalOperationKey}`,
      fencingToken: claim.fencingToken,
      error: String(error).slice(0, 500),
    });
    throw error;
  }
}
export async function dispatchCaseConnectorMutation(input: {
  c: WorkstreamConnectorCase;
  mutation: ConnectorMutation;
  dependencies?: WorkstreamConnectorDependencies;
}): Promise<void> {
  const branches = requiredBranches(input.c);
  const proposal = proposalFor(input.c, input.mutation, branches);
  const effectIdentity = {
    logicalOperationKey: proposal.logicalOperationKey,
    organizationId: input.c.organizationId,
    tenantId: input.c.organizationId,
    caseId: input.c.id,
    toolName: proposal.toolName,
    argumentsHash: hashApprovalProposal(proposal),
    providerIdempotency: true,
  };
  // Do not turn an already-confirmed journal fact into a rejected replay
  // merely because an independent task subsequently became blocked.
  if (await isConfirmedEffect(effectIdentity)) return;
  if (!workstreamPolicyGateOpen(input.c)) {
    throw new Error("Workstream connector dispatch blocked by an unmet before-workstreams policy gate.");
  }
  if (!(await mutationMayDispatch(input.c, input.mutation))) {
    throw new Error("Payroll connector dispatch blocked by incomplete runtime prerequisites.");
  }
  const governanceGate = await evaluateStoredCaseGovernanceGate({
    caseRow: input.c,
    connector: input.mutation.connector,
    operation: input.mutation.operation,
  });
  if (!governanceGate.allowed) {
    throw new ConnectorDispatchRejectedError(
      input.mutation.connector,
      `governance:${governanceGate.blockers.map((blocker) => blocker.kind).join(",")}`,
    );
  }
  const authorization = input.dependencies?.authorize
    ? await input.dependencies.authorize(proposal, input.mutation)
    : await db.transaction(async (tx) => {
        if (!isOrdinaryExecutionMutation(input.mutation)) {
          return { binding: { proposalHash: hashApprovalProposal(proposal) }, decisions: [] };
        }
        const evidence = await resolveCurrentCaseExecutionAuthorityEvidence(tx, {
          organizationId: input.c.organizationId,
          caseId: input.c.id,
          connector: input.mutation.connector,
          actualActorUserIds: [input.c.createdByUserId ?? undefined],
        });
        if (!evidence.allowed) {
          throw new ConnectorDispatchRejectedError(input.mutation.connector, evidence.reason);
        }
        return {
          binding: { proposalHash: hashApprovalProposal(proposal) },
          decisions: evidence.decisions.map((decision) => ({
            ...decision,
            proposalHash: hashApprovalProposal(proposal),
          })),
        };
      });
  const now = input.dependencies?.now?.() ?? new Date();
  const baseWrite: (
    mutation: Readonly<ConnectorMutation>,
    c: WorkstreamConnectorCase,
    tx?: OnboardingDbTransaction,
  ) => Promise<void> = input.dependencies?.write
    ? (mutation, c) => input.dependencies!.write!(mutation, c)
    : (mutation, c, tx) => journaledProductionWrite({ mutation, c, proposal, tx });
  // The outer connector adapter holds the compound-authority fence. This
  // nested backend-owned dispatch fence re-reads the governance state directly
  // before the physical writer, so an approval/revocation race cannot pass the
  // preliminary check above.
  const write = async (
    mutation: Readonly<ConnectorMutation>,
    c: WorkstreamConnectorCase,
    authorityTx?: OnboardingDbTransaction,
  ) => {
    const dispatched = await withGovernanceDispatch({
      organizationId: c.organizationId,
      operation: `${mutation.connector}:${mutation.operation}`,
      adoptedCaseSnapshot:
        c.processPolicySnapshot && typeof c.processPolicySnapshot === "object" &&
          !Array.isArray(c.processPolicySnapshot)
          ? c.processPolicySnapshot as Record<string, unknown>
          : undefined,
    }, async () => {
      const finalGate = await evaluateStoredCaseGovernanceGate({
        caseRow: c,
        connector: mutation.connector,
        operation: mutation.operation,
      });
      if (!finalGate.allowed) {
        return { blockedReason: `governance:${finalGate.blockers.map((blocker) => blocker.kind).join(",")}` };
      }
      await baseWrite(mutation, c, authorityTx);
      return { blockedReason: null };
    });
    if (dispatched.blockedReason) {
      throw new ConnectorDispatchRejectedError(mutation.connector, dispatched.blockedReason);
    }
  };

  await dispatchConnectorMutation({
    mutation: input.mutation,
    context: {
      proposal,
      binding: authorization.binding,
      decisions: authorization.decisions,
      actorIds: {
        // Contact/display strings are not principals. Only immutable IDs that
        // were authenticated elsewhere can participate in SoD validation.
        requestor: input.dependencies?.actorUserIds?.requestor ?? input.c.createdByUserId ?? undefined,
        beneficiary: input.dependencies?.actorUserIds?.beneficiary,
        executor: input.dependencies?.actorUserIds?.executor,
      },
      deniedBlockers: blockersFor(input.c, input.mutation),
      now,
      syntheticOffline: isSyntheticOfflineCase({
        workerName: input.c.workerName ?? "",
        workerEmail: input.c.workerEmail,
        workerPhone: input.c.workerPhone ?? null,
        notes: input.c.notes ?? null,
      }),
      verifyCurrentAuthority: (tx) =>
        input.dependencies?.verifyCurrentAuthority?.({
          proposal,
          decisions: authorization.decisions,
        }) ?? (
          isOrdinaryExecutionMutation(input.mutation)
            ? (tx
              ? resolveCurrentCaseExecutionAuthorityEvidence(tx, {
                  organizationId: input.c.organizationId,
                  caseId: input.c.id,
                  connector: input.mutation.connector,
                  actualActorUserIds: [
                    input.dependencies?.actorUserIds?.requestor ?? input.c.createdByUserId ?? undefined,
                    input.dependencies?.actorUserIds?.beneficiary,
                    input.dependencies?.actorUserIds?.executor,
                  ],
                }).then((evidence) => evidence.allowed
                  ? { allowed: true as const }
                  : { allowed: false as const, reason: evidence.reason })
              : Promise.resolve({ allowed: false as const, reason: "authority_fence_transaction_required" }))
            : verifyCurrentCompoundAuthorities({
                proposal,
                decisions: authorization.decisions,
                actorIds: [
                  input.dependencies?.actorUserIds?.requestor,
                  input.dependencies?.actorUserIds?.beneficiary,
                  input.dependencies?.actorUserIds?.executor,
                ],
                now,
              })
        ),
      withAuthorityFence: (performWrite) =>
        input.dependencies?.withAuthorityFence?.(performWrite) ??
        db.transaction(async (tx) => {
        // Every revoke operation takes this same transaction-scoped tenant
        // fence. The lock remains held while the provider call is made, so a
        // revocation cannot commit between final live verification and write.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${proposal.tenantId}))`);
        // Do not trust the case snapshot captured before the effect was
        // claimed. Gate C completion/revocation uses this same tenant fence;
        // taking the row lock after it serializes a completion-first race
        // before the external writer is invoked.
        const [liveCase] = await tx.select().from(onbCases)
          // The document writer inserts child rows while this fenced
          // transaction is open. NO KEY UPDATE still serializes concurrent
          // case-state writers, while allowing the child FK KEY SHARE lock;
          // UPDATE would self-block through the separate writer connection.
          .where(eq(onbCases.id, input.c.id)).for("no key update");
        if (!liveCase || liveCase.organizationId !== proposal.tenantId) {
          throw new ConnectorDispatchRejectedError(input.mutation.connector, "case_not_found");
        }
        if (liveCase.lifecycleStage === "complete") {
          throw new ConnectorDispatchRejectedError(input.mutation.connector, "case_completed");
        }
        if (
          (liveCase.hireType === "external-fte" || liveCase.hireType === "contractor" || liveCase.hireType === "rehire") &&
          liveCase.offerAcceptanceComplete !== true
        ) {
          throw new ConnectorDispatchRejectedError(input.mutation.connector, "offer_acceptance_not_current");
        }
        return performWrite(tx);
      }),
    },
    write: (mutation, tx) => write(mutation, input.c, tx),
  });
}
/** Startup recovery is intentionally limited to the missing document-pack
 * operation; it must not opportunistically dispatch the other workstreams. */
export async function dispatchDocumentPackRecovery(
  c: WorkstreamConnectorCase,
): Promise<void> {
  const [documentMutation] = workstreamMutations(c);
  await dispatchCaseConnectorMutation({ c, mutation: documentMutation! });
}
function workstreamMutations(c: WorkstreamConnectorCase): ConnectorMutation[] {
  const mutations: ConnectorMutation[] = [
    {
      connector: "documents",
      operation: "send-envelope",
      payload: {
        caseId: c.id,
        workerCategory: c.workerCategory,
        geography: c.geography,
        hireType: c.hireType,
        pack: documentPackFor(c as CaseRow).map((item) => ({
          key: item.key,
          label: item.label,
          category: item.category,
          required: item.required,
        })),
      },
    },
  ];
  for (const system of applicableSystems(c)) {
    if (system.key === "bgv") {
      mutations.push({
        connector: "background-verification",
        operation: "open-check",
        payload: { caseId: c.id, system: system.key },
      });
    } else if (system.key === "itsm") {
      mutations.push({
        connector: "iam",
        operation: "provision-account",
        payload: { caseId: c.id, system: system.key },
      });
    } else {
      mutations.push({
        connector: "payroll",
        operation: "enrol-worker",
        payload: { caseId: c.id, system: system.key },
      });
    }
  }
  return mutations;
}

export async function dispatchWorkstreamConnectorMutations(
  c: WorkstreamConnectorCase,
  dependencies?: WorkstreamConnectorDependencies,
): Promise<void> {
  const syntheticOffline = isSyntheticOfflineCase({
    workerName: c.workerName ?? "",
    workerEmail: c.workerEmail,
    workerPhone: c.workerPhone ?? null,
    notes: c.notes ?? null,
  });
  if (syntheticOffline) return;
  // This is also called by watchdog recovery, so it must independently retain
  // Gate A rather than trusting the engine caller.
  if (
    (c.hireType === "external-fte" || c.hireType === "contractor" || c.hireType === "rehire") &&
    c.offerAcceptanceComplete === false
  ) return;
  if (!workstreamPolicyGateOpen(c)) return;
  await withCaseDispatchGuard(c.id, async (caseRow) => {
      if (isSyntheticOfflineCase(caseRow)) return;
      // Never trust the pre-guard row; a context correction/evidence
      // rejection may have blocked the case while this worker was waiting.
      if (!workstreamPolicyGateOpen(caseRow)) return;
      for (const mutation of workstreamMutations(caseRow)) {
        if (!await mutationMayDispatch(caseRow, mutation)) continue;
        await dispatchCaseConnectorMutation({ c: caseRow, mutation, dependencies });
      }
    }, { onOffline: async () => undefined });
}
