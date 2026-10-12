import { Router, type IRouter } from "express";
import { db, onbCases } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveEffectiveAccessInTransaction } from "../lib/access-governance";
import healthRouter from "./health";
import platformAdminRouter from "./platform-admin";
import corpusRouter from "./corpus";
import scenariosRouter from "./scenarios";
import flowOverridesRouter from "./flow-overrides";
import actualsRouter from "./actuals";
import customIntentsRouter from "./custom-intents";
import workbookRouter from "./workbook";
import sensitivityRouter from "./sensitivity";
import slideDeckRouter from "./slide-deck";
import onboardingRouter from "./onboarding";
import onboardingCaseSimulationRouter from "./onboarding-case-simulation";
import onboardingChecklistProfileDraftRouter from "./onboarding-checklist-profile-draft";
import onboardingBatchIntakeRouter from "./onboarding-batch-intake";
import onboardingBatchUploadRouter from "./onboarding-batch-upload";
import onboardingStandardIntakeRouter from "./onboarding-standard-intake";
import onboardingTaIntakeRouter from "./onboarding-ta-intake";
import onboardingSlaRouter from "./onboarding-sla";
import onboardingContactRouter from "./onboarding-contact";
import onboardingCaseExplainabilityRouter from "./onboarding-case-explainability";
import onboardingEarlyTenureRouter from "./onboarding-early-tenure";
import onboardingStandardOperationsRouter from "./onboarding-standard-operations";
import onboardingStandardProvidersRouter from "./onboarding-standard-providers";
import onboardingFrontlineOperationsRouter from "./onboarding-frontline-operations";
import onboardingWorkforceTransfersRouter from "./onboarding-workforce-transfers";
import pricingRateSetsRouter from "./pricing-rate-sets";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import intentRegistryRouter from "./intent-registry";
import scenarioFilesRouter from "./scenario-files";
import organizationsRouter from "./organizations";
import candidatePublicRouter from "./candidate-public";
import candidateAdminRouter from "./candidate-admin";
import onboardingUatTestCenterRouter from "./onboarding-uat-test-center";
import onboardingFairnessRouter from "./onboarding-fairness";
import actionCenterRouter from "./action-center";
import { requireAuth } from "../middlewares/require-auth";
import { requireTenantContext } from "../middlewares/tenant-context";
import onboardingAuditRouter from "./onboarding-audit";
import { protectedAuditCapture } from "../middlewares/protected-audit";
import governanceRouter from "./governance";
import hrPolicyRouter from "./hr-policies";
import privacyLifecycleRouter from "./privacy-lifecycle";
import agentInvocationsRouter from "./agent-invocations";
import { hroRequestContext } from "../middlewares/hro-context";
import hroContextRouter from "./hro-context";
import employeeVaultRouter, { employeeVaultSourceRouter } from "./employee-vault";
import employeeVaultEmployerRouter from "./employee-vault-employer";
import uatAuthRouter from "./uat-auth";
import { requireUatAdmission } from "../middlewares/uat-admission";

const router: IRouter = Router();
// Deleted namespaces must not fall through to organization-id matching.
// These tombstones perform no authentication bootstrap, parsing or mutation.
router.use(["/organizations/demo-controller-setup", "/onboarding/demo-controller"], (_req, res) => {
  res.sendStatus(404);
});
router.use(healthRouter);
router.use(uatAuthRouter);
router.use(platformAdminRouter);
router.use(organizationsRouter);
router.use(candidatePublicRouter);
// Independent employees authenticate here, before HRO membership resolution.
router.use(employeeVaultSourceRouter);
router.use(employeeVaultRouter);
// TA middleware uses a tenant-pinned HMAC source contract rather than a
// browser Clerk session. Its own middleware authenticates every request.
router.use(onboardingTaIntakeRouter);
router.use((req, res, next) => {
  // Provider webhooks authenticate themselves and the demo-login bootstrap
  // must remain reachable before a Clerk session exists.
  if (
    req.path.startsWith("/onboarding/webhooks/") ||
    req.path.startsWith("/onboarding/ta-intake/") ||
    req.path === "/onboarding/demo-login" ||
    req.path === "/onboarding/demo-login/logout"
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
router.use(hroRequestContext);
// Imported service requests have no onboarding execution adapter. Keep every
// onboarding mutation fail-closed, including direct calls bypassing the UI.
// DELETE retains the existing hold-aware deletion path.
router.use("/onboarding/cases/:caseId", async (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(req.method)) { next(); return; }
  const caseId = Number(req.params.caseId);
  if (!Number.isSafeInteger(caseId) || caseId < 1) { next(); return; }
  const [record] = await db.select({ hireType: onbCases.hireType }).from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, req.organizationId!))).limit(1);
  if (record?.hireType === "service-request") {
    const access = await db.transaction(tx => resolveEffectiveAccessInTransaction(tx, {
      organizationId: req.organizationId!, principalType: "human", principalId: req.authUserId!, caseId, purpose: "held-service-request-mutation",
    }));
    if (!access.allows.includes("flow.case.edit")) { res.status(403).json({ message: "Current case-flow edit access is required." }); return; }
    res.status(409).json({ message: "This request is held for specialist review. Onboarding mutations cannot authorize or execute this service request." });
    return;
  }
  next();
});
router.use(hroContextRouter);
router.use(requireUatAdmission);
router.use(employeeVaultEmployerRouter);
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
router.use(onboardingCaseSimulationRouter);
router.use(onboardingRouter);
router.use(onboardingAuditRouter);
router.use(onboardingBatchIntakeRouter);
router.use(onboardingBatchUploadRouter);
router.use(onboardingStandardIntakeRouter);
router.use(onboardingStandardProvidersRouter);
router.use(actionCenterRouter);
router.use(governanceRouter);
router.use(hrPolicyRouter);
router.use(privacyLifecycleRouter);
router.use(agentInvocationsRouter);
router.use(onboardingUatTestCenterRouter);
router.use(onboardingFairnessRouter);
router.use(onboardingSlaRouter);
router.use(onboardingStandardOperationsRouter);
router.use(onboardingFrontlineOperationsRouter);
router.use(onboardingWorkforceTransfersRouter);
router.use(onboardingContactRouter);
router.use(onboardingCaseExplainabilityRouter);
router.use(onboardingEarlyTenureRouter);
router.use(candidateAdminRouter);
router.use(pricingRateSetsRouter);
router.use(enterpriseArchitectureRouter);
router.use(intentRegistryRouter);

export default router;
