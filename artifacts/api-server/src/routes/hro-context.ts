import { Router, type IRouter } from "express";
import { db, hroContextTransactions, hroContextSteps } from "@workspace/db";
import { registeredDemoProfile } from "../lib/demo-principal";
import { getOrganizationId } from "../lib/organization-scope";
import { resolveEffectiveAccess } from "../lib/access-governance";
import { HRO_WORKFLOWS } from "../lib/hro-context/core";
import { ListHroContextTransactionsQueryParams } from "@workspace/api-zod";
import { getContextRetentionStatus, saveContextRetentionPolicy } from "../lib/hro-context/retention";
import { SensitiveLifecycleConflictError, SensitiveLifecyclePermissionError, SensitiveLifecycleValidationError } from "../lib/onboarding/sensitive-lifecycle";
import { and, desc, eq, sql } from "drizzle-orm";
import { decodeHistoryCursor, encodeHistoryCursor, HISTORY_PAGE_SIZE } from "../lib/hro-context/history-pagination";

const router: IRouter = Router();
for (const method of ["get", "put"] as const) {
  router[method]("/context-manager/retention", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!req.authUserId) { res.status(401).json({ message: "Authentication required" }); return; }
      if (await registeredDemoProfile(req.authUserId)) { res.status(403).json({ message: "Shared demo logins cannot review retention." }); return; }
      const organizationId = getOrganizationId(req);
      res.json(method === "get" ? await getContextRetentionStatus(organizationId, req.authUserId)
        : await saveContextRetentionPolicy(organizationId, req.authUserId, req.body));
    } catch (error) {
      if (error instanceof SensitiveLifecyclePermissionError || error instanceof SensitiveLifecycleValidationError || error instanceof SensitiveLifecycleConflictError) {
        res.status(error instanceof SensitiveLifecyclePermissionError ? 403 : error instanceof SensitiveLifecycleConflictError ? 409 : 400).json({ message: error.message });
        return;
      }
      next(error);
    }
  });
}
router.get("/context-manager/transactions", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    const parsed = ListHroContextTransactionsQueryParams.safeParse(req.query);
    if (!parsed.success || Object.keys(req.query).some(key =>
      !["view", "workflow", "status", "correlationId", "cursor"].includes(key))) {
      res.status(400).json({ message: "Invalid execution history filter" });
      return;
    }
    const filters = parsed.data;
    const operator = filters.view === "operator";
    // Shared public demo credentials must never expose another visitor's work,
    // even if someone accidentally grants the dedicated operator capability.
    if (await registeredDemoProfile(req.authUserId)) {
      if (operator) res.status(403).json({ message: "Operator history is unavailable for shared demo logins" });
      else res.json({ available: false, operatorAvailable: false, transactions: [] });
      return;
    }
    const organizationId = getOrganizationId(req);
    const canInvestigate = async () => (await resolveEffectiveAccess({
      organizationId, principalType: "human", principalId: req.authUserId!,
    })).allows.includes("data.context.metadata.read");
    const operatorAvailable = await canInvestigate();
    if (operator && !operatorAvailable) {
      res.status(403).json({ message: "Live execution metadata permission required" });
      return;
    }
    const scope = { organizationId, userId: req.authUserId,
      workflow: filters.workflow, status: filters.status, correlationId: filters.correlationId };
    let position: ReturnType<typeof decodeHistoryCursor> | undefined;
    if (filters.cursor) {
      try {
        if (!operator) throw new Error("Operator pagination only");
        position = decodeHistoryCursor(filters.cursor, scope);
      } catch {
        res.status(400).json({ message: "Invalid execution history cursor for this tenant and filters" });
        return;
      }
    }
    const transactions = await db.select({
      id: hroContextTransactions.id, anchorId: hroContextTransactions.anchorId,
      correlationId: hroContextTransactions.correlationId,
      parentTransactionId: hroContextTransactions.parentTransactionId,
      workflow: hroContextTransactions.workflow, status: hroContextTransactions.status,
      version: hroContextTransactions.version, executorType: hroContextTransactions.executorType,
      initiatorType: hroContextTransactions.initiatorType,
      startedAt: hroContextTransactions.startedAt, finishedAt: hroContextTransactions.finishedAt,
      // PostgreSQL microseconds must survive the cursor; JS Date loses them.
      cursorStartedAt: sql<string>`to_char(${hroContextTransactions.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(hroContextTransactions).where(and(
      eq(hroContextTransactions.organizationId, organizationId),
      operator ? undefined : eq(hroContextTransactions.initiatingUserId, req.authUserId),
      filters.workflow ? eq(hroContextTransactions.workflow, filters.workflow) : undefined,
      filters.status ? eq(hroContextTransactions.status, filters.status) : undefined,
      filters.correlationId ? eq(hroContextTransactions.correlationId, filters.correlationId) : undefined,
      position ? sql`(${hroContextTransactions.startedAt}, ${hroContextTransactions.id}) < (${position.startedAt}::timestamptz, ${position.id}::text)` : undefined,
    )).orderBy(desc(hroContextTransactions.startedAt), desc(hroContextTransactions.id))
      .limit(operator ? HISTORY_PAGE_SIZE + 1 : HISTORY_PAGE_SIZE);

    const page = transactions.slice(0, HISTORY_PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor = operator && transactions.length > HISTORY_PAGE_SIZE && last
      ? encodeHistoryCursor(scope, last.cursorStartedAt, last.id) : null;
    const history = await Promise.all(page.map(async ({ cursorStartedAt: _cursorStartedAt, ...transaction }) => ({
      ...transaction,
      ageSeconds: Math.max(0, Math.floor((Date.now() - transaction.startedAt.getTime()) / 1000)),
      steps: (await db.select({
        code: hroContextSteps.code, createdAt: hroContextSteps.createdAt, metrics: hroContextSteps.metrics,
      }).from(hroContextSteps).where(and(
        eq(hroContextSteps.organizationId, organizationId),
        eq(hroContextSteps.transactionId, transaction.id),
      )).orderBy(desc(hroContextSteps.id)).limit(20)).reverse().map(step => ({
        code: step.code, createdAt: step.createdAt,
        ...(step.metrics.inputBytes === undefined ? {} : { inputBytes: step.metrics.inputBytes }),
        ...(step.metrics.outputTokens === undefined ? {} : { outputTokens: step.metrics.outputTokens }),
      })),
    })));
    // Disclosure uses live authority too, not a saved request/context permission.
    const stillAuthorized = await canInvestigate();
    if (operator && !stillAuthorized) {
      res.status(403).json({ message: "Execution metadata permission is no longer active" });
      return;
    }
    res.json({ available: true, operatorAvailable: stillAuthorized, workflows: HRO_WORKFLOWS,
      transactions: history, nextCursor });
  } catch (error) { next(error); }
});
export default router;
