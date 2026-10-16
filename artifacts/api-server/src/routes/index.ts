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
import clientOperationsSettingsRouter from "./client-operations-settings";
import offboardingRouter from "./offboarding";
import hroEmailIntakeRouter from "./hro-email-intake";
import { isSeparationOrLegacyExit } from "../lib/onboarding/separation-isolation";
import onboardingCaseSimulationRouter from "./onboarding-case-simulation";
import onboardingChecklistProfileDraftRouter from "./onboarding-checklist-profile-draft";
import onboardingBatchIntakeRouter from "./onboarding-batch-intake";
import onboardingBatchUploadRouter from "./onboarding-batch-upload";
import onboardingStandardIntakeRouter from "./onboarding-standard-intake";
import onboardingTaIntakeRouter from "./onboarding-ta-intake";
import onboardingSlaRouter from "./onboarding-sla";
import onboardingContactRouter from "./onboarding-contact";
import onboardingCaseExplainabilityRouter from "./onboarding-case-explainability";
import transactionContextRouter from "./transaction-context";
import onboardingEarlyTenureRouter from "./onboarding-early-tenure";
import onboardingStandardOperationsRouter from "./onboarding-standard-operations";
import onboardingStandardProvidersRouter from "./onboarding-standard-providers";
import onboardingFrontlineOperationsRouter from "./onboarding-frontline-operations";
import onboardingWorkforceTransfersRouter from "./onboarding-workforce-transfers";
import pricingRateSetsRouter from "./pricing-rate-sets";
import pricingSheetsRouter from "./pricing-sheets";
import enterpriseArchitectureRouter from "./enterprise-architecture";
import intentRegistryRouter from "./intent-registry";
import intentCatalogRouter from "./intent-catalog";
import agentCatalogueRouter from "./agent-catalogue";
import scenarioFilesRouter from "./scenario-files";
import organizationsRouter from "./organizations";
import candidatePublicRouter from "./candidate-public";
import candidateAdminRouter from "./candidate-admin";
import onboardingUatTestCenterRouter from "./onboarding-uat-test-center";
import onboardingFairnessRouter from "./onboarding-fairness";
import actionCenterRouter from "./action-center";
import controlTowerRouter from "./control-tower";
import workforceInsightsRouter from "./workforce-insights";
import actionConversationsRouter from "./action-conversations";
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
import { caseRetirementFence } from "../middlewares/case-retirement";
import onboardingOfflinePreparationRouter from "./onboarding-offline-preparation";

const router: IRouter = Router();

router.use((req, res, next) => {
  const retired = /^\/onboarding\/authority\/(?:governance(?:\/|$)|bootstrap(?:\/|$)|assignments(?:\/|$)|unresolved-approvals(?:\/|$))/i.test(req.path) ||
    /^\/onboarding\/policy-authorities(?:\/|$)/i.test(req.path) ||
    /^\/governance\/(?:assignments(?:\/|$)|authority-bootstrap(?:\/|$)|authority-options(?:\/|$))/i.test(req.path);
  if (retired) {
    res.status(410).json({ message: "Specialist authority administration is retired. Use ordinary scoped access governance and explicit human decisions. Historical records are unchanged." });
    return;
  }
  next();
});
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
// TA middleware authenticates its tenant-pinned HMAC source contract.
router.use(onboardingTaIntakeRouter);
router.use((req, res, next) => {
  // Provider webhooks and demo-login bootstrap authenticate independently.
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
router.use(requireUatAdmission);
// This exact-source, named-permission draft endpoint has its own independent
// UAT/controller/collection fences and does not admit any operational effects.
router.use(onboardingOfflinePreparationRouter);
router.use(caseRetirementFence);
// Read-only analysis precedes mutation-only separation/service-request gates.
// The explanation router owns its current read/disclosure checks.
router.use(onboardingCaseExplainabilityRouter);
router.use(actionConversationsRouter);
router.use(transactionContextRouter);
// Service requests have no onboarding execution adapter; deletion keeps its
// existing hold-aware path. Separation closure remains specification-blocked.
router.use("/onboarding/cases/:caseId", async (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
  const caseId = Number(req.params.caseId);
  if (!Number.isSafeInteger(caseId) || caseId < 1) { next(); return; }
  const [record] = await db.select({ hireType: onbCases.hireType, processPolicySnapshot: onbCases.processPolicySnapshot }).from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, req.organizationId!))).limit(1);
  if (record && isSeparationOrLegacyExit(record)) {
    res.status(409).json({ message: "Separation cases require the dedicated offboarding lifecycle. Final closure blocked: section 4.6 requirements pending. Historical exit-labelled records remain review-only." });
    return;
  }
  if (req.method === "DELETE") { next(); return; }
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
router.use(offboardingRouter);
router.use(hroEmailIntakeRouter);
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
router.use(clientOperationsSettingsRouter);
router.use(onboardingAuditRouter);
router.use(onboardingBatchIntakeRouter);
router.use(onboardingBatchUploadRouter);
router.use(onboardingStandardIntakeRouter);
router.use(onboardingStandardProvidersRouter);
router.use(actionCenterRouter);
router.use(controlTowerRouter);
router.use(workforceInsightsRouter);
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
router.use(onboardingEarlyTenureRouter);
router.use(candidateAdminRouter);
router.use(pricingRateSetsRouter);
router.use(enterpriseArchitectureRouter);
router.use(intentRegistryRouter);
router.use(intentCatalogRouter);
router.use(agentCatalogueRouter);

export default router;
