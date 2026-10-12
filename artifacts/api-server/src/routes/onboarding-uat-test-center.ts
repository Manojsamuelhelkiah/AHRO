import { Router, type IRouter } from "express";
import {
  ApplyOnboardingUatRunActionBody, ApplyOnboardingUatRunActionParams, ApplyOnboardingUatRunActionResponse,
  CreateOnboardingUatRunBody, CreateOnboardingUatRunResponse, DownloadOnboardingUatEvidenceReportParams,
  DownloadOnboardingUatEvidenceReportResponse, DownloadOnboardingUatFixturePackParams, DownloadOnboardingUatFixturePackResponse,
  GetOnboardingLearningCatalogResponse, GetOnboardingUatCatalogResponse, GetOnboardingUatRunParams, GetOnboardingUatRunResponse,
} from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { portalPublicBase } from "../lib/onboarding/portal-link-issuance";
import { applyUatAction, createUatRun, evidenceReport, fixturePack, getLearningCatalog, getUatCatalog, getUatRun } from "../lib/onboarding/uat-test-center";

const router: IRouter = Router();
const known = (body: unknown, keys: string[]) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
function status(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "UatRunNotFound" || name === "UatScenarioNotFound") return 404;
  if (name.includes("Conflict") || name === "UatRealEmailBlocked") return 409;
  return name.startsWith("Uat") ? 400 : 500;
}
router.get("/onboarding/uat", async (req, res, next): Promise<void> => {
  try { res.json(GetOnboardingUatCatalogResponse.parse(await getUatCatalog(getOrganizationId(req)))); } catch (error) { next(error); }
});
router.get("/onboarding/learning-catalog", async (_req, res, next): Promise<void> => {
  try { res.json(GetOnboardingLearningCatalogResponse.parse(getLearningCatalog())); } catch (error) { next(error); }
});
router.post("/onboarding/uat/runs", async (req, res, next): Promise<void> => {
  try {
    if (!known(req.body, ["scenarioId", "mode", "requestId"])) { res.status(400).json({ error: "Unknown request field." }); return; }
    const parsed = CreateOnboardingUatRunBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    try { res.status(201).json(CreateOnboardingUatRunResponse.parse(await createUatRun(getOrganizationId(req), req.authUserId!, parsed.data, req.organizationRole ?? "tenant-member"))); }
    catch (error) { res.status(status(error)).json({ error: error instanceof Error ? error.message : "Unable to create UAT run." }); }
  } catch (error) { next(error); }
});
router.get("/onboarding/uat/runs/:runId", async (req, res, next): Promise<void> => {
  try {
    const params = GetOnboardingUatRunParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    const run = await getUatRun(getOrganizationId(req), params.data.runId);
    if (!run) { res.status(404).json({ error: "UAT run not found." }); return; }
    res.json(GetOnboardingUatRunResponse.parse(run));
  } catch (error) { next(error); }
});
router.post("/onboarding/uat/runs/:runId/actions", async (req, res, next): Promise<void> => {
  try {
    const params = ApplyOnboardingUatRunActionParams.safeParse(req.params);
    if (!params.success || !known(req.body, ["expectedVersion", "requestId", "kind", "stepId", "result", "note", "system", "operation", "state", "hours", "eventKey", "fixtureId", "scannerState"])) { res.status(400).json({ error: "Invalid action request." }); return; }
    const action = ApplyOnboardingUatRunActionBody.safeParse(req.body);
    if (!action.success) { res.status(400).json({ error: action.error.message }); return; }
    try {
      const publicBase = action.data.kind === "issue-candidate-portal" ? portalPublicBase(req) : undefined;
      res.json(ApplyOnboardingUatRunActionResponse.parse(await applyUatAction(getOrganizationId(req), req.authUserId!, params.data.runId, action.data, { publicBase, actorRole: req.organizationRole ?? "tenant-member" })));
    }
    catch (error) { res.status(status(error)).json({ error: error instanceof Error ? error.message : "Unable to update UAT run." }); }
  } catch (error) { next(error); }
});
router.get("/onboarding/uat/runs/:runId/fixture-pack", async (req, res, next): Promise<void> => {
  try {
    const params = DownloadOnboardingUatFixturePackParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    const run = await getUatRun(getOrganizationId(req), params.data.runId);
    if (!run) { res.status(404).json({ error: "UAT run not found." }); return; }
    res.type("text/plain").set("Content-Disposition", `attachment; filename="uat-${run.runId}-fixtures.txt"`).send(DownloadOnboardingUatFixturePackResponse.parse(fixturePack(run)));
  } catch (error) { next(error); }
});
router.get("/onboarding/uat/runs/:runId/evidence-report", async (req, res, next): Promise<void> => {
  try {
    const params = DownloadOnboardingUatEvidenceReportParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    const run = await getUatRun(getOrganizationId(req), params.data.runId);
    if (!run) { res.status(404).json({ error: "UAT run not found." }); return; }
    res.set("Content-Disposition", `attachment; filename="uat-${run.runId}-evidence.json"`).json(DownloadOnboardingUatEvidenceReportResponse.parse(evidenceReport(run)));
  } catch (error) { next(error); }
});
export default router;