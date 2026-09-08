import type { onbCases } from "@workspace/db/schema";
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
  createConnectorProposal,
  dispatchConnectorMutation,
  type ConnectorMutation,
} from "./connector-adapters";
import { trackCaseSystems } from "./system-watcher";

type CaseRow = typeof onbCases.$inferSelect;

export type WorkstreamConnectorCase = Pick<
  CaseRow,
  | "id"
  | "workerEmail"
  | "workerCategory"
  | "hireType"
  | "geography"
  | "legalEntity"
  | "lifecycleStage"
  | "recruiterName"
  | "updatedAt"
  | "workstreams"
>;

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

function blockersFor(c: WorkstreamConnectorCase): string[] {
  return (c.workstreams as Array<{ blockers?: string[] }>).flatMap(
    (workstream) => workstream.blockers ?? [],
  );
}

function proposalFor(
  c: WorkstreamConnectorCase,
  mutation: ConnectorMutation,
  branches: PlanBranch[],
): ApprovalProposal {
  return createConnectorProposal({
    mutation,
    tenantId: c.legalEntity,
    caseId: String(c.id),
    planVersion: Math.floor(c.updatedAt.getTime() / 1000),
    requiredBranchSet: branches,
    logicalOperationKey: `${c.legalEntity}:${c.id}:${mutation.connector}:${mutation.operation}`,
    policyVersion: "onboarding-runtime-v1",
    evidenceRefs: [`case:${c.id}:updated:${c.updatedAt.toISOString()}`],
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
): DocumentSeedCase {
  if (
    payload === null ||
    Array.isArray(payload) ||
    typeof payload !== "object" ||
    typeof payload.caseId !== "number" ||
    typeof payload.workerCategory !== "string" ||
    typeof payload.geography !== "string" ||
    typeof payload.hireType !== "string" ||
    typeof payload.lifecycleStage !== "string"
  ) {
    throw new Error("Approved document payload is incomplete");
  }
  return {
    id: payload.caseId,
    workerCategory: payload.workerCategory,
    geography: payload.geography,
    hireType: payload.hireType,
    lifecycleStage: payload.lifecycleStage,
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
    await seedDocumentsForCase(documentSeedFrom(mutation.payload));
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
  const authorization = input.dependencies?.authorize
    ? await input.dependencies.authorize(proposal, input.mutation)
    : {
        binding: { proposalHash: hashApprovalProposal(proposal) },
        decisions: [],
      };
  const now = input.dependencies?.now?.() ?? new Date();
  const write = input.dependencies?.write ?? productionWrite;

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
      deniedBlockers: blockersFor(input.c),
      now,
    },
    write: (mutation) => write(mutation, input.c),
  });
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
        lifecycleStage: c.lifecycleStage,
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
  for (const mutation of workstreamMutations(c)) {
    await dispatchCaseConnectorMutation({ c, mutation, dependencies });
  }
}