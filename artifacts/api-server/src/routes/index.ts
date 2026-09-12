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
import onboardingChecklistProfileDraftRouter from "./onboarding-checklist-profile-draft";
import onboardingBatchIntakeRouter from "./onboarding-batch-intake";
import onboardingSlaRouter from "./onboarding-sla";
import onboardingContactRouter from "./onboarding-contact";
import onboardingCaseExplainabilityRouter from "./onboarding-case-explainability";
import pricingRateSetsRouter from "./pricing-rate-sets";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import intentRegistryRouter from "./intent-registry";
import scenarioFilesRouter from "./scenario-files";
import organizationsRouter from "./organizations";
import candidatePublicRouter from "./candidate-public";
import candidateAdminRouter from "./candidate-admin";
import onboardingDemoControllerRouter from "./onboarding-demo-controller";
import actionCenterRouter from "./action-center";
import { requireAuth } from "../middlewares/require-auth";
import { requireTenantContext } from "../middlewares/tenant-context";
import onboardingAuditRouter from "./onboarding-audit";
import { protectedAuditCapture } from "../middlewares/protected-audit";
import governanceRouter from "./governance";
import hrPolicyRouter from "./hr-policies";
import privacyLifecycleRouter from "./privacy-lifecycle";

const router: IRouter = Router();
router.use(healthRouter);
router.use(organizationsRouter);
router.use(candidatePublicRouter);
router.use((req, res, next) => {
  // Provider webhooks authenticate themselves and the demo-login bootstrap
  // must remain reachable before a Clerk session exists.
  if (
    req.path.startsWith("/onboarding/webhooks/") ||
    req.path === "/onboarding/demo-login"
  ) {
    next();
    return;
  }
  requireAuth(req, res, () => {
    void requireTenantContext(req, res, () => {
      void protectedAuditCapture(req, res, next);
    });
  });
});
router.use(corpusRouter);
router.use(scenariosRouter);
router.use(scenarioFilesRouter);
router.use(flowOverridesRouter);
router.use(actualsRouter);
router.use(customIntentsRouter);
router.use(workbookRouter);
router.use(sensitivityRouter);
router.use(pricingSheetsRouter);
router.use(slideDeckRouter);
// Keep the draft route ahead of the monolithic profile :profileId route.  The
// latter is intentionally retained for the existing editor endpoints.
router.use(onboardingChecklistProfileDraftRouter);
router.use(onboardingRouter);
router.use(onboardingAuditRouter);
router.use(onboardingBatchIntakeRouter);
router.use(actionCenterRouter);
router.use(governanceRouter);
router.use(hrPolicyRouter);
router.use(privacyLifecycleRouter);
router.use(onboardingDemoControllerRouter);
router.use(onboardingSlaRouter);
router.use(onboardingContactRouter);
router.use(onboardingCaseExplainabilityRouter);
router.use(candidateAdminRouter);
router.use(pricingRateSetsRouter);
router.use(enterpriseArchitectureRouter);
router.use(intentRegistryRouter);

export default router;
