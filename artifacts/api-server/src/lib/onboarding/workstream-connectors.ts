import { type onbCases, type OnbChecklistTemplateItem, type OnbReadinessItemRow } from "@workspace/db/schema";
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
  claimEffectDispatch,
  confirmEffect,
  ensureEffectJournalEntry,
  isConfirmedEffect,
  markAmbiguousEffectForManualRepair,
} from "./effect-journal";

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
};

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
  await trackCaseSystems(payload.caseId, [system]);
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
  if (input.mutation.connector === "payroll" && workforceRuntimeEnabled((input.c.processPolicySnapshot ?? {}) as Record<string, unknown>)) {
    const runtime = await evaluateWorkforceRuntimePrerequisites({ organizationId: input.c.organizationId, caseId: input.c.id, workstream: "payroll" });
    if (!runtime.active || !runtime.allowed) {
    throw new Error("Payroll connector dispatch blocked by incomplete runtime prerequisites.");
    }
  }
  const authorization = input.dependencies?.authorize
    ? await input.dependencies.authorize(proposal, input.mutation)
    : {
        binding: { proposalHash: hashApprovalProposal(proposal) },
        decisions: [],
      };
  const now = input.dependencies?.now?.() ?? new Date();
  const write = input.dependencies?.write ?? productionWrite;
  // Validate every non-provider boundary before claiming a durable effect.
  // A denial is not an attempted write and must not strand a journal claim.
  await dispatchConnectorMutation({
    mutation: input.mutation,
    context: {
      proposal, binding: authorization.binding, decisions: authorization.decisions,
      actorIds: { requestor: `case:${input.c.id}:recruiter:${input.c.recruiterName}`, beneficiary: `case:${input.c.id}:worker:${input.c.workerEmail}`, executor: "onboarding-engine" },
      deniedBlockers: blockersFor(input.c, input.mutation), now,
      syntheticOffline: isSyntheticOfflineCase({ workerName: input.c.workerName ?? "", workerEmail: input.c.workerEmail, workerPhone: input.c.workerPhone ?? null, notes: input.c.notes ?? null }),
    },
    write: async () => undefined,
  });

  const logicalOperationKey = proposal.logicalOperationKey;
  const owner = `workstream-dispatch:${input.c.id}:${logicalOperationKey}`;
  const journal = await ensureEffectJournalEntry(effectIdentity);
  const claim = await claimEffectDispatch({
    logicalOperationKey,
    organizationId: input.c.organizationId,
    tenantId: input.c.organizationId,
    caseId: input.c.id,
    toolName: proposal.toolName,
    argumentsHash: hashApprovalProposal(proposal),
    providerIdempotency: true,
    owner,
    expectedFencingToken: journal.fencingToken,
  });
  if (claim.kind === "reuse_confirmed") return;
  if (claim.kind !== "claimed") {
    throw new Error(`Connector effect ${logicalOperationKey} is unavailable for dispatch (${claim.kind}).`);
  }
  try {
    await dispatchConnectorMutation({
    mutation: input.mutation,
    context: {
      proposal,
      binding: authorization.binding,
      decisions: authorization.decisions,
      actorIds: {
        requestor: `case:${input.c.id}:recruiter:${input.c.recruiterName}`,
        beneficiary: `case:${input.c.id}:worker:${input.c.workerEmail}`,
        executor: "onboarding-engine",
      },
      deniedBlockers: blockersFor(input.c, input.mutation),
      now,
      syntheticOffline: isSyntheticOfflineCase({
        workerName: input.c.workerName ?? "",
        workerEmail: input.c.workerEmail,
        workerPhone: input.c.workerPhone ?? null,
        notes: input.c.notes ?? null,
      }),
    },
      write: (mutation) => write(mutation, input.c),
    });
    if (!await confirmEffect({
      logicalOperationKey, organizationId: input.c.organizationId, owner, fencingToken: claim.fencingToken,
    })) throw new Error("Connector write completed but effect confirmation lost its fencing claim.");
  } catch (error) {
    if (error instanceof ConnectorDispatchRejectedError) throw error;
    // A write may have happened. Do not spin/replay a failed boundary without
    // first reconciling the durable operation record.
    await markAmbiguousEffectForManualRepair({
      logicalOperationKey, organizationId: input.c.organizationId, owner, fencingToken: claim.fencingToken,
      error: error instanceof Error ? error.message : "Unknown connector dispatch error",
    });
    throw error;
  }
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