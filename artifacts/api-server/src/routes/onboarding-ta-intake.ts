import { Router, type IRouter } from "express";
import { requireTrustedTaIntake } from "../middlewares/ta-intake-auth";
import { commitStandardIntake } from "./onboarding-standard-intake";

const router: IRouter = Router();

router.post("/onboarding/ta-intake/events", requireTrustedTaIntake, commitStandardIntake);

export default router;