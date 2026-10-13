import { Router, type IRouter, type Request, type Response } from "express";
import {
  ConfigureHroEmailIntakeBody, UpdateHroEmailRouteBody, ReviewHroEmailRequestBody, ConvertHroEmailRequestBody, ResolveHroEmailTriageBody,
} from "@workspace/api-zod";
import {
  emailIntakeReadiness, configureEmailIntake, updateEmailRoute, listEmailRequests, getEmailRequest,
  reviewEmailRequest, convertEmailRequest, listEmailTriage, resolveEmailTriage,
} from "../lib/hro-email-service";
import { getOrganizationId } from "../lib/organization-scope";
import { SeparationError } from "../lib/offboarding/model";
import { logger } from "../lib/logger";
import { readEmailPrivateBody } from "../lib/hro-email-private-source";
const router: IRouter = Router();
const handle = (fn: (r: Request, s: Response) => Promise<unknown>) => async (r: Request, s: Response) => {
  s.setHeader("Cache-Control", "no-store");
  try { await fn(r, s); }
  catch (e) {
    if (e instanceof SeparationError) s.status(e.status).json({ message: e.message });
    else {
      logger.error({ component: "hro-email-intake" }, "Email intake request failed; private details withheld");
      s.status(503).json({ message: "Email intake could not apply this request. Reload and retry; no external work was started." });
    }
  }
};
const parse = (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, value: unknown) => {
  const p = schema.safeParse(value);
  if (!p.success) throw new SeparationError("Invalid email intake request. Reload the current form and use its allowed fields.", 400);
  return p.data;
};
const actor = (r: Request) => r.authUserId!;
router.get("/onboarding/email-intake", handle(async (r, s) => s.json(await emailIntakeReadiness(getOrganizationId(r), actor(r)))));
router.post("/onboarding/email-intake", handle(async (r, s) => s.status(201).json(await configureEmailIntake(getOrganizationId(r), actor(r), parse(ConfigureHroEmailIntakeBody, r.body)))));
router.patch("/onboarding/email-intake/routes/:routeId", handle(async (r, s) => s.json(await updateEmailRoute(getOrganizationId(r), actor(r), String(r.params.routeId), parse(UpdateHroEmailRouteBody, r.body)))));
router.get("/onboarding/email-intake/requests", handle(async (r, s) => s.json(await listEmailRequests(getOrganizationId(r), actor(r), typeof r.query.before === "string" ? r.query.before : undefined))));
router.get("/onboarding/email-intake/requests/:requestId", handle(async (r, s) => s.json(await getEmailRequest(getOrganizationId(r), actor(r), String(r.params.requestId)))));
router.get("/onboarding/email-intake/requests/:requestId/source", handle(async (r, s) => s.json(await readEmailPrivateBody(getOrganizationId(r), actor(r), String(r.params.requestId)))));
router.patch("/onboarding/email-intake/requests/:requestId", handle(async (r, s) => s.json(await reviewEmailRequest(getOrganizationId(r), actor(r), String(r.params.requestId), parse(ReviewHroEmailRequestBody, r.body)))));
router.post("/onboarding/email-intake/requests/:requestId/convert", handle(async (r, s) => s.json(await convertEmailRequest(getOrganizationId(r), actor(r), String(r.params.requestId), parse(ConvertHroEmailRequestBody, r.body)))));
router.get("/onboarding/email-intake/triage", handle(async (r, s) => s.json(await listEmailTriage(actor(r)))));
router.post("/onboarding/email-intake/triage/:requestId", handle(async (r, s) => s.json(await resolveEmailTriage(actor(r), String(r.params.requestId), parse(ResolveHroEmailTriageBody, r.body)))));
export default router;
