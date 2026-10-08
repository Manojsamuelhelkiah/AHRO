import { and, eq, sql } from "drizzle-orm";
import {
  accessAgents,
  agentInvocationAudit,
  db,
  onbCases,
} from "@workspace/db";
import {
  ACCESS_GOVERNANCE_CATALOG,
  resolveEffectiveAccessInTransaction,
} from "./access-governance";
import { appendProtectedAuditInTransaction, protectedAuditCaseReference } from "./onboarding/protected-audit";
import type { OnboardingDbTransaction } from "./onboarding/settings";

type InvocationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const AGENT_TOOL_CATALOG = ACCESS_GOVERNANCE_CATALOG.tools;
export const EXECUTABLE_AGENT_TOOL_KEYS = ["tool.case.read"] as const;
const TOOL_REQUIRED_SCOPE: Record<ExecutableAgentToolKey, readonly string[]> = {
  "tool.case.read": ["tool.case.read", "data.case.readiness.read"],
};
export type ExecutableAgentToolKey = (typeof EXECUTABLE_AGENT_TOOL_KEYS)[number];

export type EvaluateAgentInvocationInput = {
  requestedOrganizationId?: string;
  trustedOrganizationId: string;
  requestedAgentId: string;
  registeredAgentId?: string;
  agentActive: boolean;
  agentOwnerUserId?: string;
  initiatingUserId: string;
  caseBelongsToTenant: boolean;
  toolKey: string;
  effectiveAccess: readonly string[];
};

export type InvocationDenialCode =
  | "TENANT_MISMATCH"
  | "AGENT_NOT_ACTIVE"
  | "AGENT_OWNER_MISMATCH"
  | "CASE_OUT_OF_SCOPE"
  | "UNKNOWN_TOOL"
  | "TOOL_NOT_IMPLEMENTED"
  | "TOOL_ACCESS_DENIED"
  | "RUN_REPLAY";

export type InvocationAuthorization =
  | { allowed: true; delegatedScope: string[]; toolKey: ExecutableAgentToolKey }
  | { allowed: false; reasonCode: InvocationDenialCode };

/**
 * Pure fail-closed decision function, kept independently testable from the
 * database boundary. Only the authenticated caller and server-resolved
 * registration/access facts are authoritative.
 */
export function evaluateAgentInvocation(input: EvaluateAgentInvocationInput): InvocationAuthorization {
  if (
    input.requestedOrganizationId !== undefined &&
    input.requestedOrganizationId !== input.trustedOrganizationId
  ) return { allowed: false, reasonCode: "TENANT_MISMATCH" };
  if (!input.registeredAgentId || input.registeredAgentId !== input.requestedAgentId || !input.agentActive) {
    return { allowed: false, reasonCode: "AGENT_NOT_ACTIVE" };
  }
  if (!input.agentOwnerUserId || input.agentOwnerUserId !== input.initiatingUserId) {
    return { allowed: false, reasonCode: "AGENT_OWNER_MISMATCH" };
  }
  if (!input.caseBelongsToTenant) return { allowed: false, reasonCode: "CASE_OUT_OF_SCOPE" };
  if (!(AGENT_TOOL_CATALOG as readonly string[]).includes(input.toolKey)) {
    return { allowed: false, reasonCode: "UNKNOWN_TOOL" };
  }
  if (!(EXECUTABLE_AGENT_TOOL_KEYS as readonly string[]).includes(input.toolKey)) {
    return { allowed: false, reasonCode: "TOOL_NOT_IMPLEMENTED" };
  }
  const requiredScope = TOOL_REQUIRED_SCOPE[input.toolKey as ExecutableAgentToolKey];
  if (requiredScope.some((key) => !input.effectiveAccess.includes(key))) {
    return { allowed: false, reasonCode: "TOOL_ACCESS_DENIED" };
  }
  return {
    allowed: true,
    toolKey: input.toolKey as ExecutableAgentToolKey,
    delegatedScope: [...requiredScope],
  };
}

export type InvokeAgentToolInput = {
  organizationId: string;
  /** Caller-selected lookup key only; registration is always resolved in DB. */
  agentId: string;
  initiatingUserId: string;
  runId: string;
  correlationId: string;
  caseId: number;
  purpose: string;
  toolKey: string;
  /** Used only to explicitly reject a conflicting tenant claim; never authority. */
  requestedOrganizationId?: string;
};

export type InvokeAgentToolResult =
  | {
    outcome: "success";
    auditId: number;
    result: { caseId: number; lifecycleStage: string };
  }
  | { outcome: "denied"; auditId: number; reasonCode: InvocationDenialCode }
  | { outcome: "failure"; auditId: number };

function normalizedPurpose(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

function auditableToolKey(value: string): string {
  return (AGENT_TOOL_CATALOG as readonly string[]).includes(value) ? value : "unknown";
}

function actionForTool(toolKey: string): string {
  return toolKey === "tool.case.read" ? "case.metadata.read" : "tool.not-executed";
}

async function appendInvocationAudit(
  tx: InvocationTransaction,
  input: {
    organizationId: string;
    agentId: string | null;
    agentVersion: number | null;
    initiatingUserId: string;
    runId: string;
    correlationId: string;
    delegatedScope: string[];
    caseId: number;
    purpose: string;
    toolKey: string;
    action: string;
    outcome: "success" | "denied" | "failure";
    reasonCode?: string;
  },
) {
  const [row] = await tx.insert(agentInvocationAudit).values({
    ...input,
    reasonCode: input.reasonCode ?? null,
  }).returning({ id: agentInvocationAudit.id });
  if (!row) throw new Error("Agent invocation audit record was not created.");
  return row.id;
}

async function appendInvocationProtectedAudit(
  tx: InvocationTransaction,
  input: {
    organizationId: string;
    initiatingUserId: string;
    agentId: string;
    caseId: number;
    correlationId: string;
    toolName: string;
    outcome: "success" | "denied" | "failure";
  },
): Promise<void> {
  await appendProtectedAuditInTransaction(tx as OnboardingDbTransaction, {
    organizationId: input.organizationId,
    actorId: input.initiatingUserId,
    actorKind: "authenticated",
    actorAuthority: "registered-agent-invocation",
    action: `agent.invocation.${input.outcome}`,
    outcome: input.outcome,
    objectType: "agent",
    objectId: input.agentId,
    caseReference: protectedAuditCaseReference(input.caseId),
    source: "agent-invocation",
    correlationId: input.correlationId,
    payload: { toolName: input.toolName },
  });
}

/**
 * Executes the currently implemented, read-only case metadata tool under the
 * same tenant advisory lock used by governance revocation/writers. No request
 * body agent identity, owner, version, or permissions are accepted as authority.
 */
export async function invokeAgentTool(input: InvokeAgentToolInput): Promise<InvokeAgentToolResult> {
  const { withHroContext } = await import("./hro-context/manager");
  return withHroContext({
    organizationId: input.organizationId, subjectType: "tenant", subjectId: input.organizationId,
    workflow: "agent", initiatingUserId: input.initiatingUserId,
  }, () => invokeAgentToolInContext(input));
}

async function invokeAgentToolInContext(input: InvokeAgentToolInput): Promise<InvokeAgentToolResult> {
  const toolKey = auditableToolKey(input.toolKey);
  const action = actionForTool(input.toolKey);
  const auditToolName = (AGENT_TOOL_CATALOG as readonly string[]).includes(input.toolKey)
    ? input.toolKey
    : "unknown";
  const purpose = normalizedPurpose(input.purpose);
  let resolvedAgentId: string | null = null;
  let resolvedAgentVersion: number | null = null;

  try {
    return await db.transaction(async (tx) => {
      // Must exactly match the governance writers' tenant lock and remain held
      // through authorization, the tool operation, and durable outcome record.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId}))`);

      const [agent] = await tx.select().from(accessAgents).where(and(
        eq(accessAgents.organizationId, input.organizationId),
        eq(accessAgents.id, input.agentId),
      )).limit(1);
      const ownerUserId = agent?.ownerUserId;
      resolvedAgentId = agent?.id ?? null;
      resolvedAgentVersion = agent?.version ?? null;
      const agentActive = Boolean(agent && agent.status === "active" && !agent.revokedAt);

      const [caseRecord] = await tx.select({
        id: onbCases.id,
      }).from(onbCases).where(and(
        eq(onbCases.organizationId, input.organizationId),
        eq(onbCases.id, input.caseId),
      )).limit(1);
      const effectiveAccess = agentActive && ownerUserId === input.initiatingUserId
        ? await resolveEffectiveAccessInTransaction(tx, {
          organizationId: input.organizationId,
          principalType: "agent",
          principalId: agent.id,
          initiatorUserId: input.initiatingUserId,
          caseId: input.caseId,
          purpose,
        })
        : { allows: [] as string[], reasons: {} };
      const authorization = evaluateAgentInvocation({
        requestedOrganizationId: input.requestedOrganizationId,
        trustedOrganizationId: input.organizationId,
        requestedAgentId: input.agentId,
        registeredAgentId: agent?.id,
        agentActive,
        agentOwnerUserId: ownerUserId,
        initiatingUserId: input.initiatingUserId,
        caseBelongsToTenant: Boolean(caseRecord),
        toolKey: input.toolKey,
        effectiveAccess: effectiveAccess.allows,
      });

      if (!authorization.allowed) {
        const auditId = await appendInvocationAudit(tx, {
          organizationId: input.organizationId,
          agentId: resolvedAgentId,
          agentVersion: resolvedAgentVersion,
          initiatingUserId: input.initiatingUserId,
          runId: input.runId,
          correlationId: input.correlationId,
          delegatedScope: [],
          caseId: input.caseId,
          purpose,
          toolKey,
          action,
          outcome: "denied",
          reasonCode: authorization.reasonCode,
        });
        await appendInvocationProtectedAudit(tx, {
          organizationId: input.organizationId,
          initiatingUserId: input.initiatingUserId,
          agentId: input.agentId,
          caseId: input.caseId,
          correlationId: input.correlationId,
          toolName: auditToolName,
          outcome: "denied",
        });
        return { outcome: "denied", auditId, reasonCode: authorization.reasonCode };
      }

      const [priorSuccess] = await tx.select({ id: agentInvocationAudit.id })
        .from(agentInvocationAudit)
        .where(and(
          eq(agentInvocationAudit.organizationId, input.organizationId),
          eq(agentInvocationAudit.runId, input.runId),
          eq(agentInvocationAudit.toolKey, toolKey),
          eq(agentInvocationAudit.caseId, input.caseId),
          eq(agentInvocationAudit.outcome, "success"),
        ))
        .limit(1);
      if (priorSuccess) {
        const auditId = await appendInvocationAudit(tx, {
          organizationId: input.organizationId,
          agentId: resolvedAgentId,
          agentVersion: resolvedAgentVersion,
          initiatingUserId: input.initiatingUserId,
          runId: input.runId,
          correlationId: input.correlationId,
          delegatedScope: authorization.delegatedScope,
          caseId: input.caseId,
          purpose,
          toolKey,
          action,
          outcome: "denied",
          reasonCode: "RUN_REPLAY",
        });
        await appendInvocationProtectedAudit(tx, {
          organizationId: input.organizationId,
          initiatingUserId: input.initiatingUserId,
          agentId: input.agentId,
          caseId: input.caseId,
          correlationId: input.correlationId,
          toolName: auditToolName,
          outcome: "denied",
        });
        return { outcome: "denied", auditId, reasonCode: "RUN_REPLAY" };
      }

      // The only executable operation is an allowlisted, tenant/case-scoped
      // metadata read. No arbitrary tools, integrations, or side effects run.
      const [record] = await tx.select({
        id: onbCases.id,
        lifecycleStage: onbCases.lifecycleStage,
      }).from(onbCases).where(and(
        eq(onbCases.organizationId, input.organizationId),
        eq(onbCases.id, input.caseId),
      )).limit(1);
      if (!record) throw new Error("Authorized case disappeared during invocation.");
      const { withHroContext, recordHroContextStep } = await import("./hro-context/manager");
      await withHroContext({
        organizationId: input.organizationId, subjectType: "case", subjectId: String(record.id),
        workflow: "agent", initiatingUserId: input.initiatingUserId,
        executor: { type: "agent", id: agent.id, version: agent.version },
      }, () => recordHroContextStep("agent-authorized", { reference: action }));
      const auditId = await appendInvocationAudit(tx, {
        organizationId: input.organizationId,
        agentId: agent.id,
        agentVersion: resolvedAgentVersion,
        initiatingUserId: input.initiatingUserId,
        runId: input.runId,
        correlationId: input.correlationId,
        delegatedScope: authorization.delegatedScope,
        caseId: input.caseId,
        purpose,
        toolKey,
        action,
        outcome: "success",
      });
      await appendInvocationProtectedAudit(tx, {
        organizationId: input.organizationId,
        initiatingUserId: input.initiatingUserId,
        agentId: agent.id,
        caseId: input.caseId,
        correlationId: input.correlationId,
        toolName: auditToolName,
        outcome: "success",
      });
      return {
        outcome: "success",
        auditId,
        result: {
          caseId: record.id,
          lifecycleStage: record.lifecycleStage,
        },
      };
    });
  } catch {
    // A transaction aborted by an execution error cannot write its own audit.
    // Record a payload-free failure separately; no client error text is stored.
    const auditId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId}))`);
      const id = await appendInvocationAudit(tx, {
        organizationId: input.organizationId,
        agentId: resolvedAgentId,
        agentVersion: resolvedAgentVersion,
        initiatingUserId: input.initiatingUserId,
        runId: input.runId,
        correlationId: input.correlationId,
        delegatedScope: [],
        caseId: input.caseId,
        purpose,
        toolKey,
        action,
        outcome: "failure",
        reasonCode: "TOOL_EXECUTION_FAILED",
      });
      await appendInvocationProtectedAudit(tx, {
        organizationId: input.organizationId,
        initiatingUserId: input.initiatingUserId,
        agentId: resolvedAgentId ?? input.agentId,
        caseId: input.caseId,
        correlationId: input.correlationId,
        toolName: auditToolName,
        outcome: "failure",
      });
      return id;
    });
    return { outcome: "failure", auditId };
  }
}