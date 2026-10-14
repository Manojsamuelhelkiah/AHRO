import { Router, type IRouter } from "express";
import { GetTransactionContextResponse } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { readOnboardingContext, TransactionContextError } from "../lib/transaction-context/onboarding";
import { saveHandoff } from "../lib/transaction-context/handoff";
import { logger } from "../lib/logger";

const router: IRouter = Router();
function databaseConflict(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
    if (["40001", "23505"].includes(String((cause as { code?: unknown }).code))) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}
for (const method of ["get", "put"] as const) router[method]("/onboarding/cases/:caseId/transaction-context", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!req.authUserId) throw new TransactionContextError(401, "Authentication required.");
    const caseId = Number(req.params.caseId);
    if (!Number.isSafeInteger(caseId) || caseId < 1) throw new TransactionContextError(400, "Valid case reference required.");
    const input = { organizationId: getOrganizationId(req), caseId, userId: req.authUserId };
    const result = method === "put" ? await saveHandoff(input, req.body) : await readOnboardingContext(input);
    res.json(GetTransactionContextResponse.parse(result));
  } catch (error) {
    if (error instanceof TransactionContextError) res.status(error.status).json({ message: error.message });
    else if (error instanceof Error && (error.name.startsWith("SensitiveLifecycle") || databaseConflict(error)))
      res.status(409).json({ message: "Sources, annotation revision or privacy policy changed. Reload and review before saving." });
    else {
      // ORM insert errors may contain the bound confidential note body.
      // Never forward that error to the global logger or copy it into telemetry.
      logger.error({ operation: method }, "Transaction context unavailable");
      res.status(503).json({ message: "Transaction context is temporarily unavailable. No note was saved." });
    }
  }
});
export default router;
