import { Router, type IRouter } from "express";
import { GetActionConversationParams, GetActionConversationQueryParams, PostActionConversationBody } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { ConversationError, getConversation, postConversation } from "../lib/onboarding/action-conversations";
import { SensitiveLifecycleConflictError, SensitiveLifecyclePermissionError } from "../lib/onboarding/sensitive-lifecycle";
import { SensitiveAuthorityRequiredError } from "../lib/onboarding/sensitive-access";

const router: IRouter = Router();
router.use("/onboarding/action-center/cases/:caseId/conversation", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get("/onboarding/action-center/cases/:caseId/conversation", async (req, res, next) => {
  try {
    const params = GetActionConversationParams.parse(req.params);
    const query = GetActionConversationQueryParams.parse(req.query);
    if (!Number.isSafeInteger(params.caseId) || (query.before !== undefined && !Number.isSafeInteger(query.before))) throw new ConversationError(400, "Whole-number case and cursor identifiers are required.");
    res.json(await getConversation(getOrganizationId(req), req.authUserId!, params.caseId, query.before, query.workItemId));
  } catch (error) { handle(error, res, next); }
});
router.post("/onboarding/action-center/cases/:caseId/conversation", async (req, res, next) => {
  try {
    const params = GetActionConversationParams.parse(req.params);
    const body = PostActionConversationBody.parse(req.body);
    if (!Number.isSafeInteger(params.caseId) || body.workItemId !== undefined && !Number.isSafeInteger(body.workItemId)) throw new ConversationError(400, "Whole-number identifiers are required.");
    res.json(await postConversation(getOrganizationId(req), req.authUserId!, params.caseId, body));
  } catch (error) { handle(error, res, next); }
});
function handle(error: unknown, res: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof ConversationError) { res.status(error.status).json({ message: error.message }); return; }
  if (error instanceof Error && error.name === "ZodError") { res.status(400).json({ message: "Invalid conversation request." }); return; }
  if (error instanceof SensitiveAuthorityRequiredError || error instanceof SensitiveLifecyclePermissionError) {
    res.status(403).json({ message: "Current conversation authority and lifecycle permissions are required." }); return;
  }
  if (error instanceof SensitiveLifecycleConflictError) {
    res.status(409).json({ message: "Conversation collection is blocked by current record lifecycle or retained-record policy. Review client policies and permitted case records." }); return;
  }
  next(error);
}
export default router;
