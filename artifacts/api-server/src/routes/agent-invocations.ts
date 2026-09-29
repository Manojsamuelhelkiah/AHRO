import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { agentInvocationAudit, db } from "@workspace/db";
import { getOrganizationId } from "../lib/organization-scope";
import { invokeAgentTool } from "../lib/agent-invocation";

const router: IRouter = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(res: Response, message: string): void {
  res.status(400).json({ code: "AGENT_INVOCATION_INVALID", message });
}

router.get("/agent-invocations/audit", async (req: Request, res: Response, next) => {
  try {
    if (req.organizationRole !== "owner" && req.organizationRole !== "admin") {
      res.status(403).json({
        code: "AGENT_INVOCATION_AUDIT_FORBIDDEN",
        message: "Organization owner or administrator access is required.",
      });
      return;
    }
    const limitRaw = req.query.limit;
    const beforeIdRaw = req.query.beforeId;
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    const beforeId = beforeIdRaw === undefined ? undefined : Number(beforeIdRaw);
    if (
      !Number.isInteger(limit) || limit < 1 || limit > 200 ||
      (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1))
    ) {
      invalid(res, "limit must be between 1 and 200 and beforeId must be a positive integer.");
      return;
    }
    const organizationId = getOrganizationId(req);
    const entries = await db.select({
      id: agentInvocationAudit.id,
      agentId: agentInvocationAudit.agentId,
      agentVersion: agentInvocationAudit.agentVersion,
      initiatingUserId: agentInvocationAudit.initiatingUserId,
      runId: agentInvocationAudit.runId,
      correlationId: agentInvocationAudit.correlationId,
      delegatedScope: agentInvocationAudit.delegatedScope,
      caseId: agentInvocationAudit.caseId,
      purpose: agentInvocationAudit.purpose,
      toolKey: agentInvocationAudit.toolKey,
      action: agentInvocationAudit.action,
      outcome: agentInvocationAudit.outcome,
      reasonCode: agentInvocationAudit.reasonCode,
      createdAt: agentInvocationAudit.createdAt,
    }).from(agentInvocationAudit).where(and(
      eq(agentInvocationAudit.organizationId, organizationId),
      beforeId === undefined ? undefined : lt(agentInvocationAudit.id, beforeId),
    )).orderBy(desc(agentInvocationAudit.id)).limit(limit);
    res.json({
      entries,
      nextBeforeId: entries.length === limit ? entries[entries.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/agent-invocations", async (req: Request, res: Response, next) => {
  try {
    const body = req.body;
    if (!isObject(body)) {
      invalid(res, "A JSON invocation object is required.");
      return;
    }
    if (!req.authUserId) {
      res.status(401).json({ code: "AUTHENTICATION_REQUIRED", message: "Authenticated human initiation is required." });
      return;
    }
    if (
      typeof body.agentId !== "string" || !body.agentId.trim() ||
      typeof body.runId !== "string" || !UUID_PATTERN.test(body.runId) ||
      typeof body.correlationId !== "string" || !UUID_PATTERN.test(body.correlationId) ||
      !Number.isSafeInteger(body.caseId) || (body.caseId as number) < 1 ||
      typeof body.purpose !== "string" || !body.purpose.trim() || body.purpose.length > 300 ||
      typeof body.toolKey !== "string" || !body.toolKey.trim()
    ) {
      invalid(res, "agentId, UUID runId/correlationId, positive caseId, purpose, and toolKey are required.");
      return;
    }

    const organizationId = getOrganizationId(req);
    const result = await invokeAgentTool({
      organizationId,
      agentId: body.agentId.trim(),
      initiatingUserId: req.authUserId,
      runId: body.runId,
      correlationId: body.correlationId,
      caseId: body.caseId as number,
      purpose: body.purpose,
      toolKey: body.toolKey,
      ...(typeof body.organizationId === "string" ? { requestedOrganizationId: body.organizationId } : {}),
    });
    if (result.outcome === "denied") {
      res.status(403).json({
        code: `AGENT_INVOCATION_${result.reasonCode}`,
        message: "The authenticated human and registered agent do not authorize this invocation.",
        auditId: result.auditId,
      });
      return;
    }
    if (result.outcome === "failure") {
      res.status(500).json({
        code: "AGENT_INVOCATION_FAILED",
        message: "The authorized tool operation failed; its outcome was recorded.",
        auditId: result.auditId,
      });
      return;
    }
    res.json({ auditId: result.auditId, result: result.result });
  } catch (error) {
    next(error);
  }
});

export default router;