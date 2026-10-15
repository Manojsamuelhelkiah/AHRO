import { Router, type IRouter, type Request, type Response } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import { actionSeparation, createSeparations, listSeparations, separationDetail } from "../lib/offboarding/service";
import { SeparationError } from "../lib/offboarding/model";
import { FlowTransitionError } from "../lib/flow-manager/errors";
import { listPolicies, savePolicy, decidePolicy } from "../lib/offboarding/policy";
import { configureMailbox, convertMailbox, mailboxReadiness, reviewMailbox } from "../lib/hro-mailbox-ingress";
import { logger } from "../lib/logger";
import { provisionExchangePilots, readExchange, enrollExchange, exchangeAction, updateCommunicationChecks } from "../lib/offboarding/exchange-service";
import { exchangeSetupChoices, saveGmailDefaults } from "../lib/offboarding/exchange-setup";
const router: IRouter = Router();
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
  res.setHeader("Cache-Control", "no-store");
  try { await fn(req, res); } catch (e) {
    if (e instanceof SeparationError || e instanceof FlowTransitionError) res.status(e.status).json({ message: e.message });
    else {
      // Driver errors can contain opaque source facts or evidence in SQL
      // parameters. Never send them to generic error logging.
      logger.error({ component: "controlled-offboarding" }, "Separation request was not applied; private error details withheld");
      res.status(503).json({ message: "The separation request could not be applied. Reload the case and retry with the same source reference." });
    }
  }
};
const org = getOrganizationId, actor = (r: Request) => r.authUserId!;
const id = (r: Request) => { const v = Number(r.params.caseId); if (!Number.isSafeInteger(v) || v < 1) throw new SeparationError("Invalid case ID.", 400); return v; };
router.get("/offboarding/cases", handle(async (r, s) => s.json(await listSeparations(org(r), actor(r)))));
router.post("/offboarding/exchanges/provision", handle(async (r, s) => s.json(await provisionExchangePilots(org(r), actor(r), r.body))));
router.put("/offboarding/exchanges/defaults", handle(async (r, s) => s.json(await saveGmailDefaults(org(r), actor(r), r.body))));
router.get("/offboarding/exchanges/setup", handle(async (r, s) => {
  const caseId = r.query.caseId === undefined ? undefined : Number(r.query.caseId);
  if (caseId !== undefined && (!Number.isSafeInteger(caseId) || caseId <= 0)) throw new SeparationError("A positive case number is required.", 400);
  s.json(await exchangeSetupChoices(org(r), actor(r), caseId));
}));
router.get("/offboarding/cases/:caseId/exchanges", handle(async (r, s) => s.json(await readExchange(org(r), actor(r), id(r)))));
router.put("/offboarding/cases/:caseId/exchanges/email-indicators", handle(async (r, s) => s.json(await updateCommunicationChecks(org(r), actor(r), id(r), r.body))));
router.post("/offboarding/cases/:caseId/exchanges/email-review", handle(async (r, s) => s.json(await updateCommunicationChecks(org(r), actor(r), id(r), r.body, true))));
router.put("/offboarding/cases/:caseId/exchanges/enrollment", handle(async (r, s) => s.json(await enrollExchange(org(r), actor(r), id(r), r.body))));
router.post("/offboarding/cases/:caseId/exchanges/actions", handle(async (r, s) => s.json(await exchangeAction(org(r), actor(r), id(r), r.body))));
router.post("/offboarding/cases", handle(async (r, s) => s.status(201).json(await createSeparations(org(r), actor(r), r.body))));
router.post("/offboarding/batch", handle(async (r, s) => s.status(201).json(await createSeparations(org(r), actor(r), r.body, "batch"))));
router.get("/offboarding/cases/:caseId", handle(async (r, s) => s.json(await separationDetail(org(r), actor(r), id(r)))));
router.post("/offboarding/cases/:caseId/actions", handle(async (r, s) => s.json(await actionSeparation(org(r), actor(r), id(r), r.body))));
router.get("/offboarding/policies", handle(async (r, s) => s.json(await listPolicies(org(r), actor(r)))));
router.post("/offboarding/policies", handle(async (r, s) => s.status(201).json(await savePolicy(org(r), actor(r), r.body))));
router.post("/offboarding/policies/:policyId/:version/decision", handle(async (r, s) => s.json(await decidePolicy(org(r), actor(r), String(r.params.policyId), Number(r.params.version), r.body))));
router.get("/offboarding/mailbox", handle(async (r, s) => s.json(await mailboxReadiness(org(r), actor(r)))));
router.post("/offboarding/mailbox", handle(async (r, s) => s.status(201).json(await configureMailbox(org(r), actor(r), r.body))));
router.get("/offboarding/mailbox/requests", handle(async (r, s) => s.json(await reviewMailbox(org(r), actor(r)))));
router.post("/offboarding/mailbox/requests/:requestId/convert", handle(async (r, s) => s.json(await convertMailbox(org(r), actor(r), String(r.params.requestId), r.body))));
router.post("/offboarding/source-events/:channel", handle(async (r, s) => {
  const channel = String(r.params.channel);
  if (channel === "hris") { s.status(409).json({ message: "No authenticated HRIS separation feed is approved or connected. Record a human source event without claiming HRIS authentication." }); return; }
  if (!["manager-request", "security-request", "compliance-request"].includes(channel)) throw new SeparationError("Unsupported source channel.", 400);
  s.status(201).json(await createSeparations(org(r), actor(r), r.body, channel));
}));
export default router;
