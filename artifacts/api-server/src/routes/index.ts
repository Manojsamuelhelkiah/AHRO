import { Router, type IRouter } from "express";
import healthRouter from "./health";
import corpusRouter from "./corpus";
import scenariosRouter from "./scenarios";
import flowOverridesRouter from "./flow-overrides";
import actualsRouter from "./actuals";
import customIntentsRouter from "./custom-intents";
import workbookRouter from "./workbook";
import sensitivityRouter from "./sensitivity";
import slideDeckRouter from "./slide-deck";
import onboardingRouter from "./onboarding";
import pricingRateSetsRouter from "./pricing-rate-sets";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import intentRegistryRouter from "./intent-registry";

const router: IRouter = Router();

router.use(healthRouter);
router.use(corpusRouter);
router.use(scenariosRouter);
router.use(flowOverridesRouter);
router.use(actualsRouter);
router.use(customIntentsRouter);
router.use(workbookRouter);
router.use(sensitivityRouter);
router.use(pricingSheetsRouter);
router.use(slideDeckRouter);
router.use(onboardingRouter);
router.use(pricingRateSetsRouter);
router.use(enterpriseArchitectureRouter);
router.use(intentRegistryRouter);

export default router;
