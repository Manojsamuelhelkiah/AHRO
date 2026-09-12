import { Router, type IRouter, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import {
  answerPolicyQuestion,
  createPolicy,
  createPolicyHandoff,
  HrPolicyError,
  getPolicyVersion,
  listPolicies,
  policyHistory,
  listPolicyHandoffs,
  listPolicyReminders,
  policyCapabilities,
  publishPolicy,
  readPolicyExcerpt,
  resolvePolicyHandoff,
  retirePolicy,
  reviewPolicy,
  revisePolicy,
  submitPolicyReview,
  supersedePolicy,
} from "../lib/hr-policy-library";

function errorResponse(error: unknown, res: Response): boolean {
  if (error instanceof HrPolicyError) {
    res.status(error.statusCode).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });
    return true;
  }
  return false;
}

function policyId(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new HrPolicyError("A valid policy id is required.", 404);
  return value;
}

function positive(value: string | undefined, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new HrPolicyError(`${field} must be a positive integer.`);
  return number;
}

export function createHrPolicyRouter(): IRouter {
  const router: IRouter = Router();
  router.get("/policies/capabilities", async (req, res, next) => {
    try { res.json(await policyCapabilities(getOrganizationId(req), req.authUserId!)); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies", async (req, res, next) => {
    try { res.json({ policies: await listPolicies(getOrganizationId(req), req.authUserId!) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies/reminders", async (req, res, next) => {
    try { res.json(await listPolicyReminders(getOrganizationId(req), req.authUserId!)); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies/:policyId/history", async (req, res, next) => {
    try { res.json({ policies: await policyHistory(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId)) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies/:policyId/versions/:version", async (req, res, next) => {
    try { res.json(await getPolicyVersion(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), positive(req.params.version, "version"))); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies", async (req, res, next) => {
    try { res.status(201).json({ policy: await createPolicy(getOrganizationId(req), req.authUserId!, req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.patch("/policies/:policyId/draft", async (req, res, next) => {
    try { res.status(201).json({ policy: await revisePolicy(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/:policyId/submit-review", async (req, res, next) => {
    try { res.json({ policy: await submitPolicyReview(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/:policyId/reviews", async (req, res, next) => {
    try { res.json({ policy: await reviewPolicy(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/:policyId/publish", async (req, res, next) => {
    try { res.json({ policy: await publishPolicy(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/:policyId/supersede", async (req, res, next) => {
    try { res.json({ policy: await supersedePolicy(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/:policyId/retire", async (req, res, next) => {
    try { res.json({ policy: await retirePolicy(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), req.body) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/answer", async (req, res, next) => {
    try {
      const answer = await answerPolicyQuestion(getOrganizationId(req), req.authUserId!, req.body);
      res.status(answer.limitation ? 422 : 200).json(answer);
    } catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies/:policyId/versions/:version/excerpts/:excerptId", async (req, res, next) => {
    try { res.json(await readPolicyExcerpt(getOrganizationId(req), req.authUserId!, policyId(req.params.policyId), positive(req.params.version, "version"), req.params.excerptId)); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.get("/policies/handoffs", async (req, res, next) => {
    try { res.json({ handoffs: await listPolicyHandoffs(getOrganizationId(req), req.authUserId!) }); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/handoffs", async (req, res, next) => {
    try { res.status(201).json(await createPolicyHandoff(getOrganizationId(req), req.authUserId!, req.body)); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  router.post("/policies/handoffs/:handoffId/resolve", async (req, res, next) => {
    try { res.json(await resolvePolicyHandoff(getOrganizationId(req), req.authUserId!, positive(req.params.handoffId, "handoffId"), req.body)); }
    catch (error) { if (!errorResponse(error, res)) next(error); }
  });
  return router;
}

export default createHrPolicyRouter();