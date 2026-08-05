import { Router, type IRouter } from "express";
import healthRouter from "./health";
import corpusRouter from "./corpus";
import scenariosRouter from "./scenarios";
import flowOverridesRouter from "./flow-overrides";
import actualsRouter from "./actuals";
import customIntentsRouter from "./custom-intents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(corpusRouter);
router.use(scenariosRouter);
router.use(flowOverridesRouter);
router.use(actualsRouter);
router.use(customIntentsRouter);

export default router;
