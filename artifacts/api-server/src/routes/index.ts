import { Router, type IRouter } from "express";
import healthRouter from "./health";
import corpusRouter from "./corpus";
import scenariosRouter from "./scenarios";

const router: IRouter = Router();

router.use(healthRouter);
router.use(corpusRouter);
router.use(scenariosRouter);

export default router;
