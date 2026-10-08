import { Router, type IRouter } from "express";
import { getOrganizationId } from "../lib/organization-scope";
import { applyFairnessAction, FairnessError, fairnessReport, getFairnessProgramme } from "../lib/fairness-programme";

const router: IRouter = Router();
router.get("/onboarding/uat/fairness", async (req, res, next) => {
  try { res.json(await getFairnessProgramme(getOrganizationId(req), req.authUserId!)); }
  catch (error) { if (error instanceof FairnessError) res.status(error.status).json({ error: error.message }); else next(error); }
});
router.post("/onboarding/uat/fairness/actions", async (req, res, next) => {
  try { res.json(await applyFairnessAction(getOrganizationId(req), req.authUserId!, req.body)); }
  catch (error) { if (error instanceof FairnessError) res.status(error.status).json({ error: error.message }); else next(error); }
});
router.get("/onboarding/uat/fairness/evidence-report", async (req, res, next) => {
  try {
    const { programme } = await getFairnessProgramme(getOrganizationId(req), req.authUserId!);
    res.set("Content-Disposition", 'attachment; filename="synthetic-fairness-evidence.json"').json(fairnessReport(programme));
  } catch (error) { if (error instanceof FairnessError) res.status(error.status).json({ error: error.message }); else next(error); }
});
export default router;
