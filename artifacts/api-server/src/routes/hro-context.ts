import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, hroContextTransactions, hroContextSteps } from "@workspace/db";
import { registeredDemoProfile } from "../lib/demo-principal";
import { getOrganizationId } from "../lib/organization-scope";

const router: IRouter = Router();
router.get("/context-manager/transactions", async (req, res, next) => {
  try {
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    // Shared public demo credentials must never expose another visitor's work.
    if (await registeredDemoProfile(req.authUserId)) {
      res.json({ available: false, transactions: [] });
      return;
    }
    const organizationId = getOrganizationId(req);
    const transactions = await db.select({
      id: hroContextTransactions.id, anchorId: hroContextTransactions.anchorId,
      correlationId: hroContextTransactions.correlationId,
      parentTransactionId: hroContextTransactions.parentTransactionId,
      workflow: hroContextTransactions.workflow, status: hroContextTransactions.status,
      version: hroContextTransactions.version, executorType: hroContextTransactions.executorType,
      startedAt: hroContextTransactions.startedAt, finishedAt: hroContextTransactions.finishedAt,
    }).from(hroContextTransactions).where(and(
      eq(hroContextTransactions.organizationId, organizationId),
      eq(hroContextTransactions.initiatingUserId, req.authUserId),
    )).orderBy(desc(hroContextTransactions.startedAt), desc(hroContextTransactions.id)).limit(30);
    // Bounded last steps, not a business evidence viewer or a permission cache.
    const history = await Promise.all(transactions.map(async transaction => ({
      ...transaction,
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
    res.json({ available: true, transactions: history });
  } catch (error) { next(error); }
});
export default router;
