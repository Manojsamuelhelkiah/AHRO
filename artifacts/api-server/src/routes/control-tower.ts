import { Router, type IRouter } from "express";
import { GetControlTowerExamplesResponse } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { loadControlTowerExamples } from "../lib/onboarding/control-tower-examples";

const router: IRouter = Router();
router.get("/onboarding/control-tower/examples", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(GetControlTowerExamplesResponse.parse(
      await loadControlTowerExamples(getOrganizationId(req), req.authUserId!),
    ));
  } catch (error) { next(error); }
});
export default router;
