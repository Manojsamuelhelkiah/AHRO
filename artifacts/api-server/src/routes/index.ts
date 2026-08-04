import { Router, type IRouter } from "express";
import healthRouter from "./health";
import corpusRouter from "./corpus";
import scenariosRouter from "./scenarios";
import flowOverridesRouter from "./flow-overrides";

const router: IRouter = Router();

router.use(healthRouter);
router.use(corpusRouter);
router.use(scenariosRouter);
router.use(flowOverridesRouter);

export default router;
