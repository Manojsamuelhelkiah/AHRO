import { Router, type IRouter, type Request, type Response } from "express";
import { retiredCaseCapabilityResponse, isRetiredCaseCapabilityRequest, denyRetiredCaseCapability } from "../lib/retired-case-capabilities";
import { isHistoricalTestRecord } from "../lib/onboarding/historical-test-record";
import { isAuthoritativelyUatRunOwnedCase, authoritativelyUatRunOwnedCaseIds } from "../lib/onboarding/uat-isolation";
import { randomUUID } from "node:crypto";
import { decideApproval, getApprovalHistory } from "../lib/onboarding/approval-decisions";
import { runConnectedReadinessTick } from "../lib/onboarding/connected-readiness-automation";
import {
  getExternalAuditAnchorReviewerAmbiguousDeliveries,
  reconcileExternalAuditAnchorReviewerAlert,
} from "../lib/onboarding/external-audit-anchor-alerts";
import { summarizeChecklistProfileUsage } from "../lib/onboarding/checklist-profile-usage";
import { ensureReadinessSlaEnrollment } from "../lib/onboarding/readiness-sla-policy";
import {
  governanceSnapshotForNewCase,
  governanceDecisionSnapshotFromPolicy,
  withGovernanceDecisionSnapshot,
} from "../lib/onboarding/governance-runtime";
import { assertGovernanceMutationAllowed } from "../lib/onboarding/governance-dispatch";
import { and, desc, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityAudit,
  onbAuthorityGovernance,
  onbCases,
  onbChecklistTemplates,
  onbCommunications,
  onbConnectors,
  onbEffectJournal,
  onbEvents,
  onbCaseLogistics,
  onbSettings,
  onbSystemChecks,
  onbCandidateUploads,
  onbDocuments,
  onbVoiceSessions,
  onbWatchEmails,
  onbPolicyAuthorities,
  onbPolicyRecommendations,
  onbJobProfiles,
  onbIntakeBatchPeople,
  organizationMembershipsTable,
  type OnbSyntheticProvenance,
} from "@workspace/db/schema";
import {
  CreateOnboardingCaseBody,
  DecideOnboardingApprovalBody,
  ReceiveOnboardingInboundBody,
  SimulateOnboardingWatchEmailBody,
  TestOnboardingChannelBody,
  UpdateOnboardingConnectorBody,
  UpdateOnboardingSettingsBody,
  UpdateOnboardingChecklistItemBody,
  CreateOnboardingChecklistProfileBody,
  UpdateOnboardingChecklistProfileBody,
  RecalculateOnboardingChecklistProfileBody,
  DecideOnboardingEvidenceBody,
  ConfirmOnboardingOfferAcceptanceBody,
  GetOnboardingOutcomeKpisQueryParams,
  InitializeOnboardingOperationalRequestsBody,
  ApplyOnboardingOperationalRequestActionBody,
  GetOnboardingBgvNotificationsParams,
  ReconcileOnboardingBgvNotificationsBody,
} from "@workspace/api-zod";
import {
  defaultReadiness,
  defaultWorkstreams,
  createApproval,
  handleInbound,
  enforceOfferAcceptanceGate,
  requestOfferPackageEmail,
  offerAcceptanceRequired,
  OFFER_ACCEPTANCE_GATE_RULE,
  startOrchestration,
} from "../lib/onboarding/engine";
import { isChecklistAdministrator, setCustomChecklistItemStatus, verifyChecklistEvidence } from "../lib/onboarding/checklist";
import { getScenario, SCENARIOS, DEMO_EMAIL } from "../lib/onboarding/scenarios";
import {
  DEMO_FULL_COVERAGE_SCENARIO_KEYS,
  isDemoFullCoverageScenarioKey,
  seedDemoFullCoverage,
} from "../lib/onboarding/demo-full-coverage";
import { normalizedWorkCountry as normalizedDemoWorkCountry, isRetiredControllerCase } from "../lib/onboarding/controller-retirement";
import {
  ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS,
  ensureConnectorsSeeded,
} from "../lib/onboarding/connectors";
import {
  blockedPublishBackupReadiness,
  emailChannelInfo,
  sendOutbound,
  sendAdministrativeEmail,
  systemEmailTestAddress,
  retryCandidateEmail,
  candidateEmailAuthorization,
  whatsappChannelInfo,
} from "../lib/onboarding/channels";
import {
  getInboundEmailMonitorStatus,
  recordInbound,
  resolveHrAlertAddress,
} from "../lib/onboarding/inbound-email";
import {
  getSetting,
  setSetting,
  isValidEmail,
  HR_ALERT_EMAIL_KEY,
  AUTO_ESCALATION_CALLS_KEY,
  HR_APPROVER_EMAIL_KEY,
  autoEscalationCallsEnabled,
  acquireChecklistPolicyLock,
  getEffectiveChecklist,
  readinessFromChecklist,
  saveChecklistVersion,
  getDay1LogisticsDefault,
  setDay1LogisticsDefault,
  getCandidateLinkRetentionDays,
  isAllowedCandidateLinkRetentionDays,
  CANDIDATE_LINK_RETENTION_DAYS_KEY,
  NONWAIVABLE_SAFETY_POLICY_KEY,
  mandatoryChecklistReady,
  type OnboardingDbTransaction,
} from "../lib/onboarding/settings";
import { logisticsForCase, validateDay1LogisticsDefault } from "../lib/onboarding/logistics-defaults";
import {
  AUTOMATED_PORTAL_EMAIL_KEY,
  issueCandidatePortalLink,
  portalPublicBase,
} from "../lib/onboarding/portal-link-issuance";
import { refreshDemoAllowlist } from "../lib/onboarding/recipient-allowlist";
import { runApproverInboxTick } from "../lib/onboarding/approver-email";
import { GUARDRAILS, GUARDRAIL_CATEGORIES, getGuardrail, recordGuardrailEvent } from "../lib/onboarding/guardrails";
import { runSecurityDrill } from "../lib/onboarding/security-drill";
import { onbGuardrailEvents } from "@workspace/db/schema";
import { twilioSignatureValid } from "../lib/onboarding/twilio-signature";
import { appendProtectedAudit } from "../lib/onboarding/protected-audit";
import { listDocuments } from "../lib/onboarding/documents";
import { runScenarioFileMaintenance } from "../lib/scenario-file-lifecycle";
import { getArchivedStints } from "../lib/onboarding/records-agent";
import {
  startVoiceCall,
  simulateVoiceCall,
  getVoiceSession,
  voiceTurn,
  finalizeVoiceCall,
  gatherTwiml,
  hangupTwiml,
} from "../lib/onboarding/voice";
import {
  getSystemWatcherHealth,
  handleSystemWebhook,
  runSystemWatcherTick,
} from "../lib/onboarding/system-watcher";
import {
  getEmailWatchStatus,
  runEmailWatchTick,
  simulateVendorEmail,
} from "../lib/onboarding/email-watch";
import { runInboundEmailTick } from "../lib/onboarding/inbound-email";
import { applicableSystems, systemDef, WATCHED_SYSTEMS } from "../lib/onboarding/external-systems";
import { normalizePreference, shouldAuthorizeCandidateEmail, candidateEmailFailureFeedback } from "../lib/onboarding/channel-routing";
import {
  getCandidateAccessCleanupHealth,
  runCandidateAccessCleanup,
} from "../lib/onboarding/candidate-access-cleanup";
import { getMalwareScannerMonitorHealth } from "../lib/onboarding/malware-scanner-monitor";
import { resolveReviewerName } from "../middlewares/require-auth";
import { normalizeBgvStatus } from "../lib/onboarding/document-validation";
import { reconcileDocumentationReadiness } from "../lib/onboarding/document-validation";
import { requeueDocumentMalwareScan } from "../lib/onboarding/document-malware";
import { malwareScanRetryable, malwareUploadIsClean } from "../lib/onboarding/malware-policy";
import { latestRequiredUploadMalwareBlockers, requiredUploadMalwareBlockersForCases } from "../lib/onboarding/document-readiness-guard";
import { documentationGateConfigured } from "../lib/onboarding/engine";
import { hasTrustedBgvClearanceEvidence } from "../lib/onboarding/connector-evidence-provenance";
import { currentVaultBgvForCase, currentVaultBgvForCases } from "../lib/employee-vault/reuse";
import {
  evaluateCaseDerivedLifecycleGateInTransaction,
  evaluateSensitiveLifecycleGate,
  jurisdictionForWorkforceContext,
  SensitiveLifecycleConflictError,
  SensitiveLifecyclePermissionError,
  verifiedSensitiveAuthorityInTransaction,
  withSensitiveLifecycleFence,
} from "../lib/onboarding/sensitive-lifecycle";
import {
  calculateOutcomeKpis,
  type OutcomeBgvCheck,
  type OutcomeBgvEmail,
  type OutcomeEvent,
} from "../lib/onboarding/outcome-kpis";
import {
  loadOutcomeReportingEvidence,
  privacyScopedOutcomeExport,
  privacyScopedOutcomeExportCsv,
} from "../lib/onboarding/outcome-reporting";
import { clerkClient } from "@clerk/express";
import {
  resolveEffectiveAccess,
  resolveEffectiveAccessForCases,
  resolveEffectiveAccessInTransaction,
  type EffectiveAccess,
} from "../lib/access-governance";
import {
  getOrganizationId,
  organizationValues,
  organizationWhere,
} from "../lib/organization-scope";
import {
  AUTHORITY_ROLES,
  AUTHORITY_SCOPES,
  auditAuthority,
  authorityScopeForApproval,
  canAdministerAuthority,
  hasCurrentAuthorityScope,
  newAuthorityId,
  roleMayExerciseScope,
  verifyDecisionAuthorityInTransaction,
  decisionAuthorityStillCurrent,
} from "../lib/onboarding/decision-authority";
import { appendApprovalDecisionHistory, reopenApprovalInTransaction } from "../lib/onboarding/approval-version";
import { hasHumanPermissions } from "../lib/human-permissions";
import {
  activeReplacementDecision,
  applyChecklistOverrides,
  checklistProfileMatchingAttributes,
  disableChecklistProfile,
  invalidateEvidenceReadinessForContextChange,
  listCurrentChecklistProfiles,
  mergeChecklistReadiness,
  resolveEffectiveWorkforcePolicy,
  resolveEffectiveWorkforcePolicyInTransaction,
  saveChecklistProfile,
  saveChecklistProfileInTransaction,
  validateProfilesAgainstBase,
} from "../lib/onboarding/checklist-profiles";
import {
  classifyWorkforceContext,
  canonicalAuthorityRoleId,
  normalizedWorkforceContext,
  workforceAuthorityScope,
  WORKFORCE_STARTER_TEMPLATES,
} from "../lib/onboarding/workforce-policies";
import {
  analyzeCohortLearning,
  learningPolicyRuntimeIssue,
  parseLearningPolicy,
  type LearningPolicy,
} from "../lib/onboarding/policy-recommendations";
import {
  executeSyntheticReset,
  inspectSyntheticReset,
  SYNTHETIC_RESET_CONFIRMATION,
} from "../lib/onboarding/synthetic-reset";
import {
  applyOperationalRequestAction,
  assertWorkforceRuntimeRebaseAllowed,
  canMutateOperationalRequests,
  getOnboardingAgentCatalog,
  getOperationalRequests,
  initializeOperationalRequests,
  OperationalRequestConflictError,
  OperationalRequestAuthorizationError,
  OperationalRequestNotFoundError,
  OperationalRequestOfflineError,
} from "../lib/onboarding/operational-requests";
import {
  isSyntheticOfflineCase,
  sampleCandidateEmailEligible,
  SYNTHETIC_OFFLINE_MARKER,
  SYNTHETIC_OFFLINE_WARNING,
} from "../lib/onboarding/synthetic-offline";
import { getUatCaseIsolation } from "../lib/onboarding/uat-isolation";
import {
  acquireCaseDispatchMutationLock,
  hasActiveCaseDispatchMarker,
} from "../lib/onboarding/dispatch-guard";
import {
  canManageBgvNotifications,
  getBgvNotifications,
  updateBgvNotifications,
  parseBgvNotificationUpdateBody,
  reconcileBgvNotifications,
  BgvNotificationConflictError,
  BgvNotificationNotFoundError,
  BgvNotificationValidationError,
} from "../lib/onboarding/bgv-notifications";
import {
  DEMO_ADMIN_LOGIN_EMAIL,
  DEMO_LOGIN_EMAIL,
  SHARED_DEMO_REVIEWER_METADATA_KEY,
  SYNTHETIC_DEMO_ADMIN_METADATA_KEY,
} from "../lib/demo-reviewer";
import {
  ensureSyntheticDemoAdminAccess,
  grantSyntheticDemoAuthorityForCase,
  isExplicitSyntheticDemoCase,
  isVerifiedHybridDemoControllerCase,
  SyntheticDemoCaseAuthorityDeniedError,
} from "../lib/onboarding/demo-admin-access";
import {
  enforceDemoPrincipalMembershipCeiling,
  quarantineLegacyDemoPrincipalAuthority,
  registerDemoPrincipal,
  registeredDemoProfile,
} from "../lib/demo-principal";
import { ensureDemoOrganization } from "./organizations";
import {
  NO_SENSITIVE_ACCESS,
  redactCaseWorkforceContext,
  redactOperationalItems,
  redactSensitiveText,
  resolveSensitiveAccess,
  resolveSensitiveAccessInTransaction,
  sensitiveAccessForCaseList,
  SensitiveAuthorityRequiredError,
  withSensitiveAuthorityFence,
  restrictedDocumentView,
  sensitiveClassForDocument,
  hasOpaqueNarrativeAccess,
  hasSensitiveAccess,
  type SensitiveAccess,
} from "../lib/onboarding/sensitive-access";

import { readHroBatchRequest, policyWithoutBatchIntake } from "../lib/onboarding/hro-batch-templates";
import { isFictionalOfflineExampleCase } from "../lib/onboarding/offline-example-display";
import { CURATED_OFFLINE_EXAMPLES } from "../lib/onboarding/offline-example-extension";

const router: IRouter = Router();
router.use((req, res, next) => {
  if (/^\/onboarding\/(?:authority\/(?:governance|bootstrap|assignments|unresolved-approvals)|policy-authorities)(?:\/|$)/i.test(req.path)) {
    res.status(410).json({ code: "SPECIALIST_AUTHORITY_RETIRED", message: "Specialist authority management is retired. Historical records are retained; use ordinary access governance and explicit current-version human review." });
    return;
  }
  if (isRetiredCaseCapabilityRequest(req.method, req.path)) {
    retiredCaseCapabilityResponse(req, res, next);
    return;
  }
  next();
});
const malwareScanCanRetry = (state: string | null | undefined) => !!state && malwareScanRetryable(state);
const RESTRICTED_WORKFORCE_CONTEXT_MESSAGE =
  "This workforce-context correction cannot be saved here. No specialist handoff is available here; no changes were made.";
const CASE_PROFILE_READ_KEY = "data.case.profile.read";
const CASE_PROFILE_EDIT_KEY = "data.case.profile.edit";
const CASE_NOTES_READ_KEY = "data.case.notes.read";
const CASE_NOTES_EDIT_KEY = "data.case.notes.edit";
const CASE_FLOW_READ_KEY = "flow.case.read";
const CASE_FLOW_EDIT_KEY = "flow.case.edit";

type CaseGovernanceAccess = {
  flowRead: boolean;
  profileRead: boolean;
  profileEdit: boolean;
  notesRead: boolean;
  notesEdit: boolean;
  flowEdit: boolean;
  readinessRead: boolean;
  readinessEdit: boolean;
  documentsRead: boolean;
  documentsEdit: boolean;
  documentReviewRead: boolean;
  documentReviewEdit: boolean;
};

const NO_CASE_GOVERNANCE_ACCESS: CaseGovernanceAccess = {
  flowRead: false,
  profileRead: false,
  profileEdit: false,
  notesRead: false,
  notesEdit: false,
  flowEdit: false,
  readinessRead: false,
  readinessEdit: false,
  documentsRead: false,
  documentsEdit: false,
  documentReviewRead: false,
  documentReviewEdit: false,
};

function isDay1ReadinessApproval(
  approval: Pick<typeof onbApprovals.$inferSelect, "caseId" | "idempotencyKey">,
): boolean {
  return approval.idempotencyKey === `gateway-c:${approval.caseId}:human-queue`;
}

function caseGovernanceAccessFromEffective(access: EffectiveAccess): CaseGovernanceAccess {
  return {
    flowRead: access.allows.includes(CASE_FLOW_READ_KEY),
    profileRead: access.allows.includes(CASE_PROFILE_READ_KEY),
    profileEdit: access.allows.includes(CASE_PROFILE_EDIT_KEY),
    notesRead: access.allows.includes(CASE_NOTES_READ_KEY),
    notesEdit: access.allows.includes(CASE_NOTES_EDIT_KEY),
    flowEdit: access.allows.includes(CASE_FLOW_EDIT_KEY),
    readinessRead: access.allows.includes("data.case.readiness.read"),
    readinessEdit: access.allows.includes("data.case.readiness.edit"),
    documentsRead: access.allows.includes("data.documents.read"),
    documentsEdit: access.allows.includes("data.documents.edit"),
    documentReviewRead: access.allows.includes("flow.document-review.read"),
    documentReviewEdit: access.allows.includes("flow.document-review.edit"),
  };
}

async function caseGovernanceAccessForRequest(
  req: Request,
  row: Pick<typeof onbCases.$inferSelect, "organizationId" | "id"> &
    Partial<Pick<typeof onbCases.$inferSelect, "scenarioKey" | "syntheticProvenance" | "controllerRetired" | "notes">>,
): Promise<CaseGovernanceAccess> {
  if (!req.authUserId) return NO_CASE_GOVERNANCE_ACCESS;
  const access = await resolveEffectiveAccess({
    organizationId: row.organizationId,
    principalType: "human",
    principalId: req.authUserId,
    caseId: row.id,
    purpose: "onboarding-case-api",
  });
  const result = caseGovernanceAccessFromEffective(access);
  if (isHistoricalTestRecord(row) || await isAuthoritativelyUatRunOwnedCase(row)) {
    return { ...result, profileEdit: false, notesEdit: false, flowEdit: false,
      readinessEdit: false, documentsEdit: false, documentReviewEdit: false };
  }
  return result;
}

function caseFlowReadRequired(res: Response, access: CaseGovernanceAccess): boolean {
  if (access.flowRead) return true;
  res.status(403).json({
    message: "Current case-read access is required for this case.",
    code: "CASE_ACCESS_REQUIRED",
  });
  return false;
}

class WorkforceContextCorrectionPreconditionError extends Error {
  constructor(readonly kind: "not-found" | "conflict") {
    super(kind);
    this.name = "WorkforceContextCorrectionPreconditionError";
  }
}

class ReadinessGovernanceAccessRequiredError extends Error {
  constructor() {
    super("An explicit data.case.readiness.edit grant is required.");
    this.name = "ReadinessGovernanceAccessRequiredError";
  }
}

type SensitiveLifecycleGateMutation = "checklist-profile-replacement" | "evidence-decision";
let afterSensitiveLifecycleGateHookForTests:
  | ((mutation: SensitiveLifecycleGateMutation) => Promise<void>)
  | undefined;

/** Coordinates race-boundary tests without altering production gate behavior. */
export function setAfterSensitiveLifecycleGateHookForTests(
  hook: ((mutation: SensitiveLifecycleGateMutation) => Promise<void>) | undefined,
): void {
  afterSensitiveLifecycleGateHookForTests = hook;
}

function requireHrChecklistRole(
  req: Request,
  res: Response,
  message = "Organization owner or admin role required for checklist administration.",
): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message });
  return false;
}

function requireOperationalMutationRole(
  req: Request,
  res: Response,
): boolean {
  if (canMutateOperationalRequests(getOrganizationId(req), req.organizationRole)) {
    return true;
  }
  res.status(403).json({
    message:
      "Organization owner or admin role required for operational request mutations (Demo Organization members may use simulation-only actions).",
  });
  return false;
}

async function demoPrincipalVisibleCases<T extends {
  notes: string | null;
  scenarioKey: string | null;
  syntheticProvenance?: OnbSyntheticProvenance | null;
  candidateEmailAuthorizedAt?: Date | null;
  candidateEmailAuthorizedBy?: string | null;
}>(req: Request, rows: T[]): Promise<T[]> {
  return await registeredDemoProfile(req.authUserId!)
    ? rows.filter((row) =>
      isSyntheticOfflineCase(row) || isVerifiedHybridDemoControllerCase(row)
    )
    : rows;
}

/**
 * UAT cases have a deliberately tiny mutation surface: the separately mounted
 * candidate portal may read and privately upload evidence, while ordinary
 * control-tower routes must not alter their state, checkpoint, or ownership.
 * This also catches a damaged case that has lost its scenario key but remains
 * linked by the tenant-scoped UAT run ledger.
 */
router.use("/onboarding/cases/:caseId", async (req, res, next) => {
  const profile = await registeredDemoProfile(req.authUserId!);
  const caseId = Number(req.params.caseId);
  if (profile && Number.isSafeInteger(caseId) && caseId > 0) {
    const [caseRow] = await db.select({
      notes: onbCases.notes,
      scenarioKey: onbCases.scenarioKey,
      syntheticProvenance: onbCases.syntheticProvenance,
      candidateEmailAuthorizedAt: onbCases.candidateEmailAuthorizedAt,
      candidateEmailAuthorizedBy: onbCases.candidateEmailAuthorizedBy,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, getOrganizationId(req)),
      eq(onbCases.id, caseId),
    )).limit(1);
    if (
      !caseRow ||
      (!isSyntheticOfflineCase(caseRow) &&
        !isVerifiedHybridDemoControllerCase(caseRow))
    ) {
      res.status(403).json({
        message: "Shared demo accounts require an authorized synthetic case or an existing historical case-read grant.",
        code: "SYNTHETIC_DEMO_SCOPE_REQUIRED",
      });
      return;
    }
  }
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (!Number.isSafeInteger(caseId) || caseId < 1) {
    next();
    return;
  }
  try {
    const [retainedCase] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, getOrganizationId(req)),
      eq(onbCases.id, caseId),
    )).limit(1);
    if (retainedCase && isRetiredControllerCase(retainedCase)) {
      res.status(409).json({ message: "This case is retained historical evidence and cannot be operated." });
      return;
    }
    const isolation = await getUatCaseIsolation({
      organizationId: getOrganizationId(req),
      id: caseId,
    });
    const candidateEmailAction = req.method === "POST" &&
      (/\/offer-package-request$/.test(req.path) || /\/communications\/\d+\/retry$/.test(req.path) ||
        (/\/portal-links$/.test(req.path) && req.body?.sendEmail === true));
    const sampleEmailException = candidateEmailAction && retainedCase &&
      sampleCandidateEmailEligible(retainedCase) && !isolation.linkedToRun;
    if (isolation.isolated && !sampleEmailException) {
      res.status(409).json({
        message: "UAT-isolated cases may only use their explicit no-email candidate portal upload/read journey.",
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * One-click demo sign-in. The shared demo reviewer account uses an
 * undeliverable @example.com address, so Clerk's email-code device
 * verification can never complete for it. This endpoint issues a one-time
 * Clerk sign-in ticket for THAT ACCOUNT ONLY (equivalent access to the
 * already-public demo credentials — no other account can be minted).
 */
import {
  developmentSuperAdminEnabled, prepareDevelopmentAdminLogin,
  passwordMatches, allowDevelopmentAdminAttempt, clearDevelopmentAdminLogin,
} from "../lib/development-super-admin";

/**
 * Finds the demo reviewer account, creating it if it does not exist yet.
 * Production runs against a separate Clerk instance from development, so the
 * account must be self-healing — otherwise a fresh publish has no demo user.
 * Handles the create/create race by re-fetching on a creation conflict.
 */
type DemoAccount = {
  email: string;
  firstName: string;
  lastName: string;
  metadataKey: string;
};

const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    email: DEMO_LOGIN_EMAIL,
    firstName: "Demo",
    lastName: "Reviewer",
    metadataKey: SHARED_DEMO_REVIEWER_METADATA_KEY,
  },
  {
    email: DEMO_ADMIN_LOGIN_EMAIL,
    firstName: "Demo",
    lastName: "Administrator",
    metadataKey: SYNTHETIC_DEMO_ADMIN_METADATA_KEY,
  },
];

async function markDemoAccount(
  user: Awaited<ReturnType<typeof clerkClient.users.getUser>>,
  account: DemoAccount,
) {
  return clerkClient.users.updateUserMetadata(user.id, {
    privateMetadata: {
      [account.metadataKey]: true,
    },
  });
}

async function ensureDemoUser(account: DemoAccount) {
  const found = await clerkClient.users.getUserList({ emailAddress: [account.email] });
  if (found.data[0]) return markDemoAccount(found.data[0], account);
  try {
    return await clerkClient.users.createUser({
      emailAddress: [account.email],
      skipPasswordRequirement: true,
      firstName: account.firstName,
      lastName: account.lastName,
      privateMetadata: {
        [account.metadataKey]: true,
      },
    });
  } catch (err) {
    // Another request may have created it concurrently — re-fetch before failing.
    const refetched = await clerkClient.users.getUserList({ emailAddress: [account.email] });
    if (refetched.data[0]) return markDemoAccount(refetched.data[0], account);
    throw err;
  }
}

router.post("/onboarding/demo-login", async (req, res, next) => {
  try {
    const requested = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const account = DEMO_ACCOUNTS.find((candidate) => candidate.email === requested);
    if (!account) {
      res.status(403).json({ error: "Demo login is only available for approved demo accounts" });
      return;
    }
    if (account.email === DEMO_ADMIN_LOGIN_EMAIL) {
      // Check the private credential before creating/updating a provider user.
      if (!developmentSuperAdminEnabled()) {
        res.status(403).json({ message: "Temporary Super Admin sign-in is available only in development with its password configured." });
        return;
      }
      if (!passwordMatches(req.body?.password, process.env.DEV_SUPER_ADMIN_PASSWORD)) {
        if (!allowDevelopmentAdminAttempt("super-admin")) { res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." }); return; }
        res.status(401).json({ message: "Super Admin sign-in failed. Check the password." });
        return;
      }
    }
    const demoUser = await ensureDemoUser(account);
    if (account.email === DEMO_ADMIN_LOGIN_EMAIL && !(await prepareDevelopmentAdminLogin(req, res, demoUser.id))) return;
    await ensureDemoOrganization();
    const profile =
      account.email === DEMO_ADMIN_LOGIN_EMAIL ? "administrator" : "reviewer";
    await registerDemoPrincipal(
      demoUser.id,
      profile,
    );
    await enforceDemoPrincipalMembershipCeiling(demoUser.id);
    await quarantineLegacyDemoPrincipalAuthority(demoUser.id, profile);
    if (account.email === DEMO_ADMIN_LOGIN_EMAIL) {
      await ensureSyntheticDemoAdminAccess(demoUser.id);
    }
    const token = await clerkClient.signInTokens.createSignInToken({
      userId: demoUser.id,
      expiresInSeconds: 120,
    });
    res.json({ ticket: token.token });
  } catch (err) {
    if (err instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "A current HR/compliance authority assignment is required to retry a candidate communication.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    // The protected sign-in must never log the credential or provider payload.
    res.status(503).json({ message: "Sign-in service is temporarily unavailable." });
  }
});

router.post("/onboarding/demo-login/logout", (req, res) => {
  clearDevelopmentAdminLogin(req, res);
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type CasePresentationReads = {
  offerDelivery?: typeof onbCommunications.$inferSelect;
  bgvChecks: (typeof onbSystemChecks.$inferSelect)[];
  vaultBgvClear: boolean;
  finalApproval?: { status: string };
  malwareBlockers: number[];
  uatOwned: boolean;
};

/** Related display data is loaded only for authorized rows in this tenant. */
async function casePresentationReads(
  organizationId: string,
  rows: (typeof onbCases.$inferSelect)[],
): Promise<Map<number, CasePresentationReads>> {
  if (!rows.length) return new Map();
  const ids = rows.map(row => row.id);
  const [communications, checks, approvals, vaultClear, blockers, uatOwned] = await Promise.all([
    db.select().from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, organizationId), inArray(onbCommunications.caseId, ids),
      inArray(onbCommunications.idempotencyKey, ids.map(id => `gateway-a:${id}:offer-package:email`)),
    )),
    db.select().from(onbSystemChecks).where(and(
      eq(onbSystemChecks.organizationId, organizationId), inArray(onbSystemChecks.caseId, ids),
      eq(onbSystemChecks.system, "bgv"),
    )),
    db.select({ caseId: onbApprovals.caseId, status: onbApprovals.status, idempotencyKey: onbApprovals.idempotencyKey }).from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, organizationId), inArray(onbApprovals.caseId, ids),
      inArray(onbApprovals.idempotencyKey, ids.map(id => `gateway-c:${id}:human-queue`)),
    )).orderBy(desc(onbApprovals.id)),
    currentVaultBgvForCases(organizationId, ids),
    db.transaction(tx => requiredUploadMalwareBlockersForCases(
      tx, organizationId, rows.filter(row => documentationGateConfigured(row)).map(row => row.id),
    )),
    authoritativelyUatRunOwnedCaseIds(organizationId, rows),
  ]);
  const result = new Map(ids.map(id => [id, {
    bgvChecks: [] as (typeof onbSystemChecks.$inferSelect)[],
    vaultBgvClear: vaultClear.has(id), malwareBlockers: blockers.get(id) ?? [], uatOwned: uatOwned.has(id),
  } as CasePresentationReads]));
  for (const communication of communications) {
    const entry = result.get(communication.caseId);
    if (entry && communication.idempotencyKey === `gateway-a:${communication.caseId}:offer-package:email` &&
      !entry.offerDelivery) entry.offerDelivery = communication;
  }
  for (const check of checks) result.get(check.caseId)?.bgvChecks.push(check);
  for (const approval of approvals) {
    const entry = result.get(approval.caseId);
    if (entry && approval.idempotencyKey === `gateway-c:${approval.caseId}:human-queue` &&
      !entry.finalApproval) entry.finalApproval = approval;
  }
  return result;
}

async function deriveGateways(row: typeof onbCases.$inferSelect, presentation?: CasePresentationReads) {
  const offerRequired = offerAcceptanceRequired(row);
  const offerAuthorization = candidateEmailAuthorization(row);
  const [offerDelivery] = presentation ? [presentation.offerDelivery] : await db.select().from(onbCommunications).where(and(
    eq(onbCommunications.organizationId, row.organizationId),
    eq(onbCommunications.caseId, row.id),
    eq(onbCommunications.idempotencyKey, `gateway-a:${row.id}:offer-package:email`),
  )).limit(1);
  const bgvChecks = presentation?.bgvChecks ?? await db.select().from(onbSystemChecks).where(and(
    eq(onbSystemChecks.organizationId, row.organizationId),
    eq(onbSystemChecks.caseId, row.id),
    eq(onbSystemChecks.system, "bgv"),
  ));
  const bgv = bgvChecks[0];
  // A simulated watcher completion is display/planning data, never proof at a
  // live gate. The provenance predicate also requires an actual external
  // reference, completion timestamp, and supported inbound mechanism.
  const bgvClear = hasTrustedBgvClearanceEvidence(bgvChecks) ||
    (presentation ? presentation.vaultBgvClear : await currentVaultBgvForCase(row.organizationId, row.id));
  const bgvRequiredForDay1 = applicableSystems(row).some((system) => system.key === "bgv");
  const [finalApproval] = presentation ? [presentation.finalApproval] : await db.select({
    status: onbApprovals.status,
  }).from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, row.organizationId),
    eq(onbApprovals.caseId, row.id),
    eq(onbApprovals.idempotencyKey, `gateway-c:${row.id}:human-queue`),
  )).orderBy(desc(onbApprovals.id)).limit(1);
  const malwareBlockers = presentation ? presentation.malwareBlockers : documentationGateConfigured(row)
    ? await db.transaction((tx) => latestRequiredUploadMalwareBlockers(tx, row.organizationId, row.id))
    : [];
  const mandatoryReady = mandatoryChecklistReady(row);
  return {
    a: row.lifecycleStage === "complete" && !row.offerAcceptanceComplete
      ? { status: "not-applicable" as const, label: "Gate A — offer acceptance", reason: "Historical terminal case preserved; acceptance evidence was not retroactively inferred." }
      : !offerRequired
      ? { status: "not-applicable" as const, label: "Gate A — offer acceptance", reason: "Offer-acceptance packages are not required for this onboarding pathway." }
      : row.offerAcceptanceComplete
        ? { status: "complete" as const, label: "Gate A — offer acceptance", reason: "HR confirmed the offer-acceptance package." }
        : !offerAuthorization.allowed
          ? { status: "blocked" as const, label: "Gate A — offer acceptance", reason: `${offerAuthorization.reason} The email-only package request cannot be delivered.` }
          : offerDelivery && !["sent", "delivered"].includes(offerDelivery.status)
            ? { status: "blocked" as const, label: "Gate A — offer acceptance", reason: `Offer-package email is ${offerDelivery.status}: ${candidateEmailFailureFeedback(row.workerEmail, offerDelivery.failureReason, offerDelivery.status) ?? "Review Communications for the delivery outcome."} Human offer-acceptance confirmation is still required.` }
            : { status: "human-review" as const, label: "Gate A — offer acceptance", reason: "Candidate email is enabled by the provided address. Sending email is not acceptance; a dedicated HR confirmation is required and onboarding remains held." },
    b: row.hireType === "internal-transfer"
      ? { status: "not-applicable" as const, label: "Gate B — background verification", reason: "This internal-transfer pathway does not run a fresh BGV check." }
      : !bgv
        ? { status: "pending" as const, label: "Gate B — background verification", reason: "BGV has not yet been requested; absence is not evidence of completion." }
        : bgvClear
          ? { status: "complete" as const, label: "Gate B — background verification", reason: "The live BGV source reported clearance." }
          : bgv.status === "overdue"
            ? { status: "human-review" as const, label: "Gate B — background verification", reason: "BGV is overdue or has an exception; a human review queue item is required." }
            : { status: "pending" as const, label: "Gate B — background verification", reason: "Awaiting a live BGV source status." },
    c: row.lifecycleStage === "complete" && !finalApproval
      ? { status: "not-applicable" as const, label: "Gate C — Day-1 readiness", reason: "Historical terminal case preserved; final-review evidence was not retroactively inferred." }
      : row.lifecycleStage === "complete" && finalApproval?.status === "approved" && mandatoryReady && malwareBlockers.length === 0 && (!bgvRequiredForDay1 || bgvClear)
      ? { status: "complete" as const, label: "Gate C — Day-1 readiness", reason: "HR approved the final Day-1 review after live readiness checks." }
      : !mandatoryReady || malwareBlockers.length > 0 || (bgvRequiredForDay1 && !bgvClear)
        ? { status: "blocked" as const, label: "Gate C — Day-1 readiness", reason: malwareBlockers.length > 0 ? "Latest required upload malware evidence is not clear." : bgv ? "Trusted BGV clearance is not currently present; simulated or unproven status is excluded." : "Configured mandatory readiness items are not currently complete." }
        : finalApproval?.status === "pending"
          ? { status: "human-review" as const, label: "Gate C — Day-1 readiness", reason: "Live readiness is complete and awaits the dedicated HR final-review queue decision." }
          : finalApproval?.status === "approved"
            ? { status: "pending" as const, label: "Gate C — Day-1 readiness", reason: "Final approval was recorded but the completion reconciliation is pending." }
            : { status: "pending" as const, label: "Gate C — Day-1 readiness", reason: "Awaiting configured readiness checks and a dedicated HR final review." },
  };
}

async function sensitiveAccessForCase(req: Request, row: Pick<typeof onbCases.$inferSelect, "organizationId" | "id">): Promise<SensitiveAccess> {
  return resolveSensitiveAccess({
    organizationId: row.organizationId,
    caseId: row.id,
    actorUserId: req.authUserId,
  });
}

function redactWorkforceClassification(
  classification: typeof onbCases.$inferSelect["workforceClassification"],
  sensitiveAccess: SensitiveAccess,
) {
  if (!classification || hasOpaqueNarrativeAccess(sensitiveAccess)) return classification;
  return {
    label: classification.label,
    source: classification.source,
    confidence: classification.confidence,
    rationale: "Restricted confidential workforce-classification rationale.",
    ...(classification.correction
      ? { correction: { label: classification.correction.label } }
      : {}),
  };
}

async function serializeCase(
  row: typeof onbCases.$inferSelect,
  sensitiveAccess: SensitiveAccess = NO_SENSITIVE_ACCESS,
  caseAccess: CaseGovernanceAccess = NO_CASE_GOVERNANCE_ACCESS,
  presentation?: CasePresentationReads,
) {
  const rawGateways = caseAccess.readinessRead && caseAccess.flowRead ? await deriveGateways(row, presentation) : undefined;
  const gateways = rawGateways ? {
    a: { ...rawGateways.a, label: "Offer-Acceptance Package" },
    b: { ...rawGateways.b, label: "Background Checks" },
    c: { ...rawGateways.c, label: "Day-1 Readiness" },
  } : undefined;
  const canReadProfile = caseAccess.profileRead && caseAccess.flowRead;
  const canReadNotes = caseAccess.notesRead && caseAccess.flowRead;
  const intakeRequest = readHroBatchRequest(row.processPolicySnapshot);
  const emailIntake = row.processPolicySnapshot?.emailIntake as { requestId?: string } | undefined;
  const canReadReadiness = caseAccess.readinessRead && caseAccess.flowRead;
  // The marker is server-owned. Offline, unauthorized Demo cases are wholly
  // fictional fixtures, so their identity projection does not imply or grant
  // sensitive-record authority. Volunteered/hybrid cases remain protected.
  const fictionalOfflineIdentity = isFictionalOfflineExampleCase(row);
  // Generic fixed-inventory description only, never a bypass for mutable notes.
  const offlineExample = fictionalOfflineIdentity
    ? CURATED_OFFLINE_EXAMPLES.find(example => example.key === row.scenarioKey)
    : undefined;
  const canReadIdentity = canReadProfile &&
    (sensitiveAccess.identity || fictionalOfflineIdentity);
  const profileSensitiveAccess = canReadProfile ? sensitiveAccess : NO_SENSITIVE_ACCESS;
  return {
    id: row.id,
    controllerRetired: isHistoricalTestRecord(row) ||
      (presentation ? presentation.uatOwned : await isAuthoritativelyUatRunOwnedCase(row)),
    caseFamily: canReadProfile ? intakeRequest?.family ?? null : null,
    requestType: canReadProfile ? intakeRequest?.requestType ?? null : null,
    intakeSource: canReadProfile && canReadNotes && hasOpaqueNarrativeAccess(sensitiveAccess) && emailIntake?.requestId ? "Email" : null,
    intakeSourceUrl: canReadProfile && canReadNotes && hasOpaqueNarrativeAccess(sensitiveAccess) && emailIntake?.requestId ? `/email-intake/${encodeURIComponent(emailIntake.requestId)}` : null,
    batchIntake: canReadProfile && canReadNotes
      ? offlineExample?.values.processPolicySnapshot.batchIntake ??
        (hasOpaqueNarrativeAccess(sensitiveAccess) ? intakeRequest : null)
      : null,
    workerName: canReadIdentity ? row.workerName : "Restricted candidate",
    workerEmail: canReadIdentity ? row.workerEmail : null,
    workerPhone: canReadIdentity ? row.workerPhone : null,
    channelPreference: canReadProfile ? row.channelPreference : null,
    hireType: canReadProfile ? row.hireType : "Restricted case profile",
    workerCategory: canReadProfile ? row.workerCategory : "Restricted case profile",
    workerBand: canReadProfile ? row.workerBand : null,
    role: canReadProfile ? row.role : "Restricted case profile",
    department: canReadProfile ? row.department : "Restricted case profile",
    geography: canReadProfile ? row.geography : "Restricted case profile",
    legalEntity: canReadProfile ? row.legalEntity : "Restricted case profile",
    managerName: canReadIdentity ? row.managerName : "Restricted candidate",
    recruiterName: canReadIdentity ? row.recruiterName : "Restricted candidate",
    joiningDate: canReadProfile ? row.joiningDate : "Restricted",
    urgency: canReadProfile ? row.urgency : "Restricted",
    lifecycleStage: row.lifecycleStage,
    orchestrationStatus: row.orchestrationStatus,
    readiness: canReadReadiness
      ? redactOperationalItems(row.readiness, profileSensitiveAccess)
      : [],
    workstreams: redactOperationalItems(row.workstreams, profileSensitiveAccess),
    primarySkill: canReadProfile ? row.primarySkill : null,
    skillCriticality: canReadProfile ? row.skillCriticality : null,
    scenarioKey: canReadProfile ? row.scenarioKey : null,
    // This server-derived output flag keeps every marker-backed offline case
    // out of interactive provider/contact controls in the client.
    offlineSample: isSyntheticOfflineCase(row),
    /** Only server-marked, fictional Demo fixtures may bypass identity authority. */
    fictionalOfflineIdentity: canReadProfile && fictionalOfflineIdentity,
    planSummary: canReadNotes
      ? offlineExample?.values.planSummary ?? redactSensitiveText(row.planSummary, sensitiveAccess) ?? null
      : null,
    checklistTemplateVersion: row.checklistTemplateVersion,
    checklistSnapshot: canReadReadiness
      ? redactOperationalItems(row.checklistSnapshot, profileSensitiveAccess)
      : [],
    checklistProfileId: canReadProfile ? row.checklistProfileId : "restricted",
    checklistProfileName: canReadProfile ? row.checklistProfileName : "Restricted case profile",
    checklistProfileVersion: row.checklistProfileVersion ?? row.checklistTemplateVersion,
    checklistMatchedCriteria: canReadProfile && hasOpaqueNarrativeAccess(sensitiveAccess)
      ? row.checklistMatchedCriteria
      : {},
    checklistMatchExplanation: canReadProfile && canReadNotes
      ? redactSensitiveText(row.checklistMatchExplanation, sensitiveAccess) ?? null
      : "Restricted case profile.",
    workforceContext: canReadProfile
      ? redactCaseWorkforceContext(row.workforceContext, sensitiveAccess)
      : {},
    workforceClassification: canReadProfile
      ? redactWorkforceClassification(row.workforceClassification, sensitiveAccess)
      : null,
    workforceContextVersion: row.workforceContextVersion,
    processPolicySnapshot: canReadProfile && hasOpaqueNarrativeAccess(sensitiveAccess)
      ? policyWithoutBatchIntake(row.processPolicySnapshot)
      : {},
    jobProfileId: canReadProfile ? row.jobProfileId : null,
    jobProfileVersion: canReadProfile ? row.jobProfileVersion : null,
    orchestrationCheckpoint: row.orchestrationCheckpoint,
    candidateEmailAuthorized: candidateEmailAuthorization(row).allowed,
    offerAcceptanceComplete: row.offerAcceptanceComplete,
    offerAcceptanceCompletedAt: iso(row.offerAcceptanceCompletedAt),
    offerAcceptanceCompletedBy: row.offerAcceptanceCompletedBy,
    gateways: canReadReadiness
      ? gateways
      : {
          a: { status: "restricted", label: "Restricted readiness", reason: "Readiness details are restricted." },
          b: { status: "restricted", label: "Restricted readiness", reason: "Readiness details are restricted." },
          c: { status: "restricted", label: "Restricted readiness", reason: "Readiness details are restricted." },
        },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeEvent(
  row: typeof onbEvents.$inferSelect,
  sensitiveAccess: SensitiveAccess = NO_SENSITIVE_ACCESS,
  caseAccess: CaseGovernanceAccess = NO_CASE_GOVERNANCE_ACCESS,
) {
  const canReadNarrative = row.caseId === null ||
    (caseAccess.flowRead && caseAccess.notesRead && caseAccess.profileRead);
  return {
    ...row,
    title: canReadNarrative
      ? redactSensitiveText(row.title, sensitiveAccess) ?? "Restricted confidential onboarding event."
      : "Restricted case event.",
    detail: canReadNarrative
      ? redactSensitiveText(row.detail, sensitiveAccess) ?? "Restricted confidential onboarding event."
      : "Restricted case event.",
    createdAt: row.createdAt.toISOString(),
  };
}

export async function serializeCaseForRequest(req: Request, row: typeof onbCases.$inferSelect) {
  const [sensitiveAccess, caseAccess] = await Promise.all([
    sensitiveAccessForCase(req, row),
    caseGovernanceAccessForRequest(req, row),
  ]);
  return serializeCase(row, sensitiveAccess, caseAccess);
}

async function serializeEventForRequest(req: Request, row: typeof onbEvents.$inferSelect) {
  const sensitiveAccess = row.caseId === null
    ? NO_SENSITIVE_ACCESS
    : await resolveSensitiveAccess({
      organizationId: row.organizationId,
      caseId: row.caseId,
      actorUserId: req.authUserId,
    });
  const caseAccess = row.caseId === null
    ? NO_CASE_GOVERNANCE_ACCESS
    : await caseGovernanceAccessForRequest(req, {
      organizationId: row.organizationId,
      id: row.caseId,
    });
  return serializeEvent(row, sensitiveAccess, caseAccess);
}

async function insertCaseAndStart(
  values: Omit<typeof onbCases.$inferInsert, "organizationId">,
  organizationId: string,
  options?: {
    startOrchestration?: boolean;
    syntheticOffline?: boolean;
    syntheticProvenance?: OnbSyntheticProvenance;
    onInserted?: (tx: OnboardingDbTransaction, row: typeof onbCases.$inferSelect) => Promise<void>;
  },
) {
  if (options?.syntheticOffline && !options.syntheticProvenance) {
    denyRetiredCaseCapability();
  }
  if (options?.syntheticOffline) {
    denyRetiredCaseCapability();
  }
  if (!options?.syntheticOffline && options?.syntheticProvenance) {
    throw new Error("Synthetic case provenance is valid only for synthetic offline creation.");
  }
  const logisticsDefault = await getDay1LogisticsDefault(organizationId);
  // Snapshot before the insert only. Existing cases are intentionally never
  // rewritten when a governance revision later changes.
  await governanceSnapshotForNewCase(organizationId);
  const row = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    const governanceSnapshot = await governanceSnapshotForNewCase(organizationId, new Date(), tx);
    const [jobProfile] = values.jobProfileId
      ? await tx.select().from(onbJobProfiles).where(and(
        eq(onbJobProfiles.organizationId, organizationId),
        eq(onbJobProfiles.profileId, values.jobProfileId),
        eq(onbJobProfiles.enabled, true),
      )).orderBy(desc(onbJobProfiles.version)).limit(1)
      : [];
    if (values.jobProfileId && !jobProfile) throw new Error("Selected job profile was not found or is retired.");
    const workforceContext = normalizedWorkforceContext({
      ...jobProfile?.context,
      ...values.workforceContext,
    });
    const workforcePolicy = await resolveEffectiveWorkforcePolicyInTransaction(
      tx,
      organizationId,
      workforceContext,
      values,
    );
    // Only this server-owned fictional branch may omit lifecycle policies.
    // Its values are generated below the authenticated Demo Administrator
    // check, not copied from the request, and every external effect remains
    // fenced off. Ordinary and volunteer-backed cases still fail closed.
    if (!options?.syntheticOffline) {
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId,
        jurisdiction: jurisdictionForWorkforceContext(workforceContext),
      });
      if (!lifecycle.allowed) throw new SensitiveLifecycleConflictError(`SENSITIVE_LIFECYCLE_BLOCKED:${lifecycle.reason}`);
    }
    const { profile, classification } = workforcePolicy;
    const [inserted] = await tx
      .insert(onbCases)
      .values({
        ...values,
        ...organizationValues(organizationId),
        syntheticProvenance: options?.syntheticProvenance ?? null,
        checklistTemplateVersion: profile.templateVersion,
        checklistSnapshot: workforcePolicy.effectiveItems,
        checklistProfileId: profile.profileId,
        checklistProfileName: profile.profileName,
        checklistProfileVersion: profile.profileVersion,
        checklistMatchedCriteria: profile.matchedCriteria,
        checklistMatchExplanation: profile.explanation,
        workforceContext,
        workforceClassification: classification,
        processPolicySnapshot: withGovernanceDecisionSnapshot({
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          templateVersion: profile.templateVersion,
          processPolicy: profile.processPolicy ?? {},
          classification,
        }, governanceSnapshot),
        jobProfileId: jobProfile?.profileId ?? null,
        jobProfileVersion: jobProfile?.version ?? null,
        readiness: readinessFromChecklist(workforcePolicy.effectiveItems),
        workstreams: defaultWorkstreams(),
        orchestrationStatus: options?.syntheticOffline ? "blocked" : "idle",
        orchestrationCheckpoint: options?.syntheticOffline ? "synthetic-offline" : null,
      })
      .returning();
    await tx.insert(onbCaseLogistics).values({
      organizationId,
      caseId: inserted.id,
      ...logisticsForCase(logisticsDefault, inserted.joiningDate),
    });
    await options?.onInserted?.(tx, inserted);
    return inserted;
  }));
  if (options?.startOrchestration !== false) startOrchestration(row.id);
  return row;
}

/* ----------------------------- dashboard ----------------------------- */

router.get("/onboarding/dashboard", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const ownedCases = await demoPrincipalVisibleCases(req, await excludeUatAggregateCases(await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, organizationId))));
    const cases = (await Promise.all(ownedCases.map(async (row) =>
      (await caseGovernanceAccessForRequest(req, row)).flowRead ? row : null,
    ))).filter((row): row is typeof ownedCases[number] => row !== null);
    const readinessCases = (await Promise.all(cases.map(async (row) =>
      (await caseGovernanceAccessForRequest(req, row)).readinessRead ? row : null,
    ))).filter((row): row is typeof cases[number] => row !== null);
    const aggregateCaseIds = new Set(cases.map((row) => row.id));
    const readinessCaseIds = new Set(readinessCases.map((row) => row.id));

    const approvalRows = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId));
    const approvals = approvalRows
      .map(({ approval }) => approval)
      .filter((approval) =>
        approval.status === "pending" &&
        aggregateCaseIds.has(approval.caseId) &&
        (!isDay1ReadinessApproval(approval) || readinessCaseIds.has(approval.caseId)));
    const recent = (await db
      .select()
      .from(onbEvents)
      .where(organizationWhere(onbEvents, organizationId))
      .orderBy(desc(onbEvents.createdAt), desc(onbEvents.id))
      .limit(60))
      .filter((event) => event.caseId === null || aggregateCaseIds.has(event.caseId))
      .slice(0, 12);

    const byStageMap = new Map<string, number>();
    for (const c of cases) {
      byStageMap.set(c.lifecycleStage, (byStageMap.get(c.lifecycleStage) ?? 0) + 1);
    }
    const now = Date.now();
    const day1AtRisk = readinessCases.filter((c) => {
      const days = (new Date(c.joiningDate).getTime() - now) / 86400000;
      const blocked =
        c.orchestrationStatus === "blocked" ||
        c.orchestrationStatus === "waiting-approval" ||
        c.workstreams.some((w) => w.blockers.length > 0);
      return days >= 0 && days <= 7 && blocked;
    }).length;

    res.json({
      totalCases: cases.length,
      byStage: Array.from(byStageMap.entries()).map(([key, count]) => ({ key, count })),
      pendingApprovals: approvals.length,
      hardBlocked: approvals.filter((approval) => approval.hitlPattern === "hard-block").length,
      day1AtRisk,
      readyCases: readinessCases.filter((c) => c.readiness.every((r) => r.status === "ready")).length,
      recentEvents: await Promise.all(recent.map((event) => serializeEventForRequest(req, event))),
    });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- scenarios ----------------------------- */

router.get("/onboarding/scenarios", (_req, res) => {
  res.json(
    SCENARIOS.map(({ key, title, description, specRef, expectedBehaviour }) => ({
      key,
      title,
      description,
      specRef,
      expectedBehaviour,
    })),
  );
});

/**
 * USERCONFIRMED one-off reset for the explicit legacy synthetic-case
 * manifest.  Preview and mutation are deliberately in the current tenant
 * router; neither endpoint accepts an organization id from the body.
 */
router.get("/onboarding/synthetic-reset", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const envelope = await inspectSyntheticReset(getOrganizationId(req));
    res.json(envelope);
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/synthetic-reset", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const expectedRevision =
      typeof req.body?.expectedRevision === "string"
        ? req.body.expectedRevision
        : "";
    const confirmation =
      typeof req.body?.confirmation === "string"
        ? req.body.confirmation
        : "";
    if (!expectedRevision) {
      res.status(400).json({ message: "expectedRevision is required." });
      return;
    }
    if (confirmation !== SYNTHETIC_RESET_CONFIRMATION) {
      res.status(400).json({
        message: `confirmation must exactly equal "${SYNTHETIC_RESET_CONFIRMATION}".`,
      });
      return;
    }
    const result = await executeSyntheticReset({
      organizationId: getOrganizationId(req),
      actorId: req.authUserId!,
      expectedRevision,
    });
    if (result.kind === "conflict") {
      res.status(409).json(result.envelope);
      return;
    }
    res.json(result.envelope);
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/scenarios/:key/run", async (req, res, next) => {
  try {
    if (getOrganizationId(req) !== DEMO_ORGANIZATION_ID) {
      res.status(403).json({ message: "Demo scenarios can only be launched in the Development Demo organization." });
      return;
    }
    const scenario = getScenario(req.params.key);
    if (!scenario) {
      res.status(404).json({ message: `Unknown scenario "${req.params.key}"` });
      return;
    }
    const joiningDate = new Date(
      Date.now() + scenario.intake.joiningDateOffsetDays * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const row = await insertCaseAndStart({
      workerName: scenario.intake.workerName,
      workerEmail: scenario.intake.workerEmail,
      workerPhone: scenario.intake.workerPhone,
      hireType: scenario.intake.hireType,
      workerCategory: scenario.intake.workerCategory,
      role: scenario.intake.role,
      department: scenario.intake.department,
      geography: scenario.intake.geography,
      legalEntity: scenario.intake.legalEntity,
      managerName: scenario.intake.managerName,
      recruiterName: scenario.intake.recruiterName,
      joiningDate,
      primarySkill: scenario.intake.primarySkill,
      skillCriticality: scenario.intake.skillCriticality,
      notes: scenario.intake.notes,
      scenarioKey: scenario.key,
      candidateEmailAuthorizedAt: null,
      candidateEmailAuthorizedBy: null,
      // Scenario launch is an authenticated workflow request, not a system
      // anonymous seed; retain the immutable requester for approval SoD.
      createdByUserId: req.authUserId!,
    }, getOrganizationId(req));
    res.status(201).json(await serializeCaseForRequest(req, row));
  } catch (err) {
    next(err);
  }
});

/**
 * The cases list's one-click coverage control is intentionally a single,
 * tenant-fenced transaction rather than a browser loop over scenario launches.
 * It creates only missing, offline Demo samples and is safe to retry.
 */
router.post("/onboarding/demo/full-coverage", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    if (organizationId !== DEMO_ORGANIZATION_ID) {
      res.status(403).json({ message: "Full sample coverage is available only in the Development Demo organization; no customer cases were created." });
      return;
    }
    if (!requireHrChecklistRole(req, res, "Organization owner or admin role required to add Development Demo samples.")) return;
    const result = await seedDemoFullCoverage(organizationId, req.authUserId ?? null);
    res.status(200).json({
      ...result,
      scenarioKeys: DEMO_FULL_COVERAGE_SCENARIO_KEYS,
      offline: true,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- cases ------------------------------- */

router.get("/onboarding/cases", async (req, res, next) => {
  try {
    const rows = await demoPrincipalVisibleCases(req, await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, getOrganizationId(req)))
      .orderBy(desc(onbCases.id)));
    const organizationId = getOrganizationId(req);
    const accessByCase = await resolveEffectiveAccessForCases({
      organizationId, principalType: "human", principalId: req.authUserId ?? "",
      purpose: "onboarding-case-list",
    }, rows.map(row => row.id));
    const visible = rows.filter(row => accessByCase.get(row.id)?.allows.includes(CASE_FLOW_READ_KEY));
    const [presentation, sensitiveByCase] = await Promise.all([
      casePresentationReads(organizationId, visible),
      sensitiveAccessForCaseList(organizationId, req.authUserId,
        new Map(visible.map(row => [row.id, accessByCase.get(row.id)!]))),
    ]);
    const serialized = await Promise.all(visible.map(row => serializeCase(
      row, sensitiveByCase.get(row.id) ?? NO_SENSITIVE_ACCESS,
      caseGovernanceAccessFromEffective(accessByCase.get(row.id)!), presentation.get(row.id),
    )));
    res.json(serialized);
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const demoProfile = await registeredDemoProfile(req.authUserId!);
    if (demoProfile) {
      retiredCaseCapabilityResponse(req, res, next);
      return;
    }
    if (demoProfile === "reviewer") {
      res.status(403).json({
        message: "Shared reviewer accounts cannot create cases. Use the Demo Administrator profile for fictional offline samples.",
        code: "SYNTHETIC_DEMO_SCOPE_REQUIRED",
      });
      return;
    }
    if (demoProfile === "administrator" && organizationId !== DEMO_ORGANIZATION_ID) {
      res.status(403).json({
        message: "Synthetic Demo cases may be created only in the Demo Organization.",
        code: "SYNTHETIC_DEMO_SCOPE_REQUIRED",
      });
      return;
    }
    const body = CreateOnboardingCaseBody.parse(req.body);
    if (["separation", "offboarding"].includes(body.hireType.toLowerCase().trim())) {
      res.status(409).json({ message: "Use controlled Separation intake. Exit requests cannot enter onboarding automation; final closure is unavailable pending section 4.6." });
      return;
    }
    if (demoProfile === "administrator") {
      const fictionalId = randomUUID().replace(/-/g, "").slice(0, 10);
      const joiningDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const row = await insertCaseAndStart({
        workerName: `Fictional Demo Hire ${fictionalId.toUpperCase()}`,
        workerEmail: `fictional-demo-${fictionalId}@example.invalid`,
        workerPhone: null,
        channelPreference: "email",
        hireType: "external-fte",
        workerCategory: "employee",
        workerBand: null,
        workforceContext: {
          workCountry: "IN",
          workEnvironment: "office",
          hiringMode: "individual",
        },
        jobProfileId: null,
        role: "People Operations Analyst",
        department: "People Operations",
        geography: "India",
        legalEntity: "Demo Organization",
        managerName: "Fictional Demo Manager",
        recruiterName: "Fictional Demo Recruiter",
        joiningDate,
        primarySkill: null,
        skillCriticality: null,
        notes: `${SYNTHETIC_OFFLINE_MARKER}\n${SYNTHETIC_OFFLINE_WARNING}`,
        candidateEmailAuthorizedAt: null,
        candidateEmailAuthorizedBy: null,
        offerAcceptanceComplete: false,
        offerAcceptanceCompletedAt: null,
        offerAcceptanceCompletedBy: null,
        createdByUserId: req.authUserId!,
      }, organizationId, {
        startOrchestration: false,
        syntheticOffline: true,
        syntheticProvenance: "onboarding-demo-fictional",
        onInserted: (tx, inserted) =>
          grantSyntheticDemoAuthorityForCase(tx, req.authUserId!, inserted),
      });
      res.status(201).json(await serializeCaseForRequest(req, row));
      return;
    }
    // Intake does not have a specialist-owned medical/accommodation record
    // path. Do not turn the general case note/context fields into an
    // ungoverned special-category collection channel.
    if ((body.notes && body.notes.trim()) ||
      JSON.stringify(body.workforceContext ?? {}).toLowerCase().includes("accessibilityneeds")) {
      res.status(409).json({
        message: "General case intake cannot save accessibility/medical details or free-form candidate notes. No specialist handoff is available here.",
      });
      return;
    }
    if (body.offerAcceptanceComplete) {
      res.status(400).json({
        message: "Offer acceptance cannot be attested during case creation. Create the case, then use the dedicated Offer-Acceptance Package confirmation endpoint.",
      });
      return;
    }
    const createAccess = caseGovernanceAccessFromEffective(await resolveEffectiveAccess({
      organizationId,
      principalType: "human",
      principalId: req.authUserId!,
      purpose: "onboarding-case-create",
    }));
    if (!createAccess.flowEdit || !createAccess.profileEdit) {
      res.status(403).json({
        message: "Explicit case-flow edit and case-profile edit grants are required to create an onboarding case.",
        code: "CASE_EDIT_ACCESS_REQUIRED",
      });
      return;
    }
    const workerEmail = body.workerEmail.trim().toLowerCase();
    const channelPreference = normalizePreference(body.channelPreference);
    if (!isValidEmail(workerEmail)) {
      res.status(400).json({ message: "Enter a valid candidate email address." });
      return;
    }
    if (body.offerAcceptanceComplete && body.hireType !== "internal-transfer") {
      res.status(400).json({ message: "Offer acceptance cannot be asserted during case creation. It requires the dedicated authority-checked Offer-Acceptance Package confirmation and durable evidence." });
      return;
    }
    // Duplicate-trigger prevention (spec §1.3): same person with an active case.
    const dupes = await db
      .select({ id: onbCases.id, stage: onbCases.lifecycleStage })
      .from(onbCases)
      .where(
        and(
          sql`lower(${onbCases.workerName}) = ${body.workerName.toLowerCase()}`,
          sql`${onbCases.lifecycleStage} not in ('complete')`,
          organizationWhere(onbCases, organizationId),
        ),
      );
    if (dupes.length > 0) {
      res.status(409).json({
        message: `An active onboarding case already exists for ${body.workerName} (case #${dupes[0].id}). Duplicate triggers must be reviewed by HR / Talent Acquisition.`,
      });
      return;
    }
    const syntheticDemoCase = false;
    const providedWorkCountry = body.workforceContext?.workCountry;
    const workCountry =
      normalizedDemoWorkCountry(providedWorkCountry) ??
      (jurisdictionForWorkforceContext({ workCountry: providedWorkCountry })
        ? providedWorkCountry!.trim().toUpperCase()
        : normalizedDemoWorkCountry(body.geography));
    if (!workCountry) {
      res.status(400).json({
        message: "Work Country is required to apply the correct lifecycle policy. Enter a country name or ISO code in Work context for policy routing.",
      });
      return;
    }
    const row = await insertCaseAndStart({
      workerName: body.workerName,
      workerEmail,
      workerPhone: body.workerPhone ?? null,
      channelPreference,
      hireType: body.hireType,
      workerCategory: body.workerCategory,
      workerBand: body.workerBand ?? null,
      workforceContext: { ...(body.workforceContext ?? {}), workCountry },
      jobProfileId: body.jobProfileId ?? null,
      role: body.role,
      department: body.department,
      geography: body.geography,
      legalEntity: body.legalEntity,
      managerName: body.managerName,
      recruiterName: body.recruiterName,
      joiningDate: body.joiningDate,
      primarySkill: body.primarySkill ?? null,
      skillCriticality: body.skillCriticality ?? null,
      // This marker and notice are generated on the server, never accepted
      // from the request body. They durably fence this branch from live work.
      notes: syntheticDemoCase
        ? `${SYNTHETIC_OFFLINE_MARKER}\n${SYNTHETIC_OFFLINE_WARNING}`
        : body.notes ?? null,
      scenarioKey: null,
      candidateEmailAuthorizedAt: syntheticDemoCase
        ? null
        : shouldAuthorizeCandidateEmail(workerEmail, channelPreference) ? new Date() : null,
      candidateEmailAuthorizedBy: syntheticDemoCase
        ? null
        : shouldAuthorizeCandidateEmail(workerEmail, channelPreference) ? req.authUserId! : null,
      offerAcceptanceComplete: body.offerAcceptanceComplete,
      offerAcceptanceCompletedAt: body.offerAcceptanceComplete ? new Date() : null,
      offerAcceptanceCompletedBy: body.offerAcceptanceComplete ? await resolveReviewerName(req.authUserId!) : null,
      createdByUserId: req.authUserId!,
    }, organizationId, syntheticDemoCase ? {
      startOrchestration: false,
      syntheticOffline: true,
      syntheticProvenance: "onboarding-demo-fictional",
      onInserted: (tx, inserted) =>
        grantSyntheticDemoAuthorityForCase(tx, req.authUserId!, inserted),
    } : undefined);
    if (!syntheticDemoCase) await ensureReadinessSlaEnrollment(organizationId, row.id);
    // Gate A owns the first candidate contact only on new/rehire pathways.
    // Unrelated onboarding pathways retain their established portal behavior.
    if (!syntheticDemoCase && candidateEmailAuthorization(row).allowed && (row.offerAcceptanceComplete || !offerAcceptanceRequired(row))) {
      await issueCandidatePortalLink({
        organizationId,
        caseId: row.id,
        issuedBy: req.authUserId!,
        publicBase: portalPublicBase(req),
        sendEmail: true,
        idempotencyKey: AUTOMATED_PORTAL_EMAIL_KEY(row.id),
      });
    }
    res.status(201).json(await serializeCaseForRequest(req, row));
  } catch (err) {
    if (err instanceof SyntheticDemoCaseAuthorityDeniedError) {
      res.status(403).json({
        message: "A current registered Demo Administrator profile and Demo Organization membership are required.",
        code: "SYNTHETIC_DEMO_SCOPE_REQUIRED",
      });
      return;
    }
    if (err instanceof SensitiveLifecycleConflictError) {
      res.status(409).json({
        message: err.message.replace(/^SENSITIVE_LIFECYCLE_BLOCKED:/, ""),
        code: "SENSITIVE_LIFECYCLE_BLOCKED",
      });
      return;
    }
    next(err);
  }
});

router.get("/onboarding/cases/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, id),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    if (!row) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const caseAccess = await caseGovernanceAccessForRequest(req, row);
    if (!caseFlowReadRequired(res, caseAccess)) return;
    res.json(await serializeCase(row, await sensitiveAccessForCase(req, row), caseAccess));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/access-permissions", async (req, res, next) => {
  try {
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication is required." });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ message: "A valid case id is required." });
      return;
    }
    const [row] = await db
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, id),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    if (!row) {
      res.status(404).json({ message: "Case not found" });
      return;
    }

    const [caseAccess, sensitiveAccess] = await Promise.all([
      caseGovernanceAccessForRequest(req, row),
      sensitiveAccessForCase(req, row),
    ]);
    res.json({
      caseId: row.id,
      access: caseAccess,
      sensitive: {
        identity: { read: sensitiveAccess.identity, edit: sensitiveAccess.edit?.identity === true },
        medical: { read: sensitiveAccess.medical, edit: sensitiveAccess.edit?.medical === true },
        payroll: { read: sensitiveAccess.payroll, edit: sensitiveAccess.edit?.payroll === true },
        bgv: { read: sensitiveAccess.bgv, edit: sensitiveAccess.edit?.bgv === true },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases/:id/offer-acceptance", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Only organization owners and admins may confirm Offer-Acceptance Package.")) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = ConfirmOnboardingOfferAcceptanceBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    // A direct confirmation immediately after create can beat the detached
    // orchestration starter. Force the durable, idempotent email-only request
    // to exist first; its effect key prevents repeated sends on retries.
    const [before] = await db.select({
      offerAcceptanceComplete: onbCases.offerAcceptanceComplete,
      hireType: onbCases.hireType,
      notes: onbCases.notes,
      syntheticProvenance: onbCases.syntheticProvenance,
      workerName: onbCases.workerName,
      workerEmail: onbCases.workerEmail,
      workerPhone: onbCases.workerPhone,
      scenarioKey: onbCases.scenarioKey,
    }).from(onbCases).where(and(eq(onbCases.id, id), eq(onbCases.organizationId, organizationId)));
    if (before && isSyntheticOfflineCase(before)) {
      res.status(409).json({ message: SYNTHETIC_OFFLINE_WARNING });
      return;
    }
    if (before && offerAcceptanceRequired(before) && !before.offerAcceptanceComplete) {
      await enforceOfferAcceptanceGate(id);
    }
    const outcome = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [current] = await tx.select().from(onbCases).where(and(
        eq(onbCases.id, id),
        eq(onbCases.organizationId, organizationId),
      )).for("update");
      if (!current) return { kind: "not-found" as const };
      if (body.note.trim()) {
        const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
          organizationId,
          jurisdiction: jurisdictionForWorkforceContext(current.workforceContext),
        });
        if (!lifecycle.allowed) return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
      }
      if (!offerAcceptanceRequired(current)) return { kind: "not-applicable" as const };
      const [gateApproval] = await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, organizationId),
        eq(onbApprovals.caseId, id),
        eq(onbApprovals.idempotencyKey, `gateway-a:${id}:human-queue`),
      )).for("update");
      if (!gateApproval) return { kind: "authority-evidence-missing" as const };
      if (current.offerAcceptanceComplete) {
        // Do not retrofit a reviewer identity onto a legacy completed Gate A.
        // A completed row without the decision/revision binding remains
        // historical evidence and cannot authorize a new provider effect.
        if (
          gateApproval.status !== "approved" ||
          gateApproval.authorityScope !== "hr-compliance-approve" ||
          !gateApproval.decidedAuthorityId ||
          !gateApproval.decidedAuthorityRevision
        ) return { kind: "authority-evidence-missing" as const };
        return { kind: "already-confirmed" as const, row: current };
      }
      // Recovery for an older successful dedicated Gate A write which
      // persisted the authority-bound decision but crashed before updating
      // the case. Consume only live, revision-bound evidence; legacy/null
      // evidence remains fail-closed.
      if (
        gateApproval.status === "approved" &&
        gateApproval.authorityScope === "hr-compliance-approve" &&
        gateApproval.decidedAuthorityId &&
        gateApproval.decidedAuthorityRevision &&
        await decisionAuthorityStillCurrent(tx, gateApproval)
      ) {
        const [row] = await tx.update(onbCases).set({
          offerAcceptanceComplete: true,
          offerAcceptanceCompletedAt: gateApproval.decidedAt ?? new Date(),
          offerAcceptanceCompletedBy: gateApproval.decidedBy,
          orchestrationStatus: "idle",
          orchestrationCheckpoint: "offer-accepted",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
          updatedAt: new Date(),
        }).where(and(eq(onbCases.id, id), eq(onbCases.organizationId, organizationId),
          eq(onbCases.offerAcceptanceComplete, false))).returning();
        if (!row) return { kind: "authority-evidence-missing" as const };
        return { kind: "confirmed" as const, row };
      }
      if (gateApproval.status !== "pending") {
        return { kind: "authority-evidence-missing" as const };
      }
      if (gateApproval.authorityScope !== "hr-compliance-approve") {
        return { kind: "authority-evidence-missing" as const };
      }
      const authority = await verifyDecisionAuthorityInTransaction(tx, {
        organizationId,
        approval: gateApproval,
        actorUserId: req.authUserId!,
      });
      if (!authority.allowed) return { kind: "unauthorized" as const };
      const decisionActor = authority.personUserId;
      const decidedAt = new Date();
      const [decidedGate] = await tx.update(onbApprovals).set({
        status: "approved",
        decidedBy: decisionActor,
        comment: body.note.trim() || null,
        decidedAt,
        decidedAuthorityId: authority.authorityId,
        decidedAuthorityRevision: authority.revision,
        permissionDecision: {
          schema: "human-permission/v1", organizationId, caseId: id,
          actorUserId: decisionActor, requiredKeys: ["tool.approval.decide", "flow.case.edit"],
          reviewedRevision: gateApproval.version, evidenceGeneration: gateApproval.version,
          decision: "approved", recordedAt: new Date().toISOString(), ownerAdminRequired: false,
        },
      }).where(and(
        eq(onbApprovals.organizationId, organizationId),
        eq(onbApprovals.id, gateApproval.id),
        eq(onbApprovals.status, "pending"),
        eq(onbApprovals.version, gateApproval.version),
      )).returning();
      if (!decidedGate) {
        return { kind: "authority-evidence-missing" as const };
      }
      await appendApprovalDecisionHistory(
        tx,
        decidedGate,
        "approved",
        decisionActor,
        body.note.trim() || null,
        decidedAt,
        "Dedicated Offer-Acceptance Package confirmation recorded",
      );
      const [row] = await tx.update(onbCases).set({
        offerAcceptanceComplete: true,
        offerAcceptanceCompletedAt: new Date(),
        offerAcceptanceCompletedBy: decisionActor,
        orchestrationStatus: "idle",
        orchestrationCheckpoint: "offer-accepted",
        orchestrationClaimOwner: null,
        orchestrationClaimUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(onbCases.id, id),
        eq(onbCases.organizationId, organizationId),
        eq(onbCases.offerAcceptanceComplete, false),
      )).returning();
      if (!row) throw new Error("Offer-acceptance confirmation was concurrently updated.");
      await tx.insert(onbEvents).values({
        organizationId,
        caseId: id,
        agent: "human",
        engine: "human",
        hitlPattern: "hard-block",
        ruleRef: "Gate A — offer-acceptance package",
        title: "Offer-Acceptance Package confirmed by HR",
        detail: `${decisionActor} confirmed the offer-acceptance package. Note: ${body.note.trim()}. The dedicated Offer-Acceptance Package confirmation releases onboarding; generic approvals do not.`,
        idempotencyKey: `gateway-a:${id}:confirmed`,
      }).onConflictDoNothing({
        target: [onbEvents.organizationId, onbEvents.idempotencyKey],
      });
      return { kind: "confirmed" as const, row };
    }));
    if (outcome.kind === "not-found") {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    if (outcome.kind === "lifecycle-blocked") {
      res.status(409).json({ message: outcome.message });
      return;
    }
    if (outcome.kind === "unauthorized") {
      res.status(403).json({ message: "Current approval-decision and case-flow edit permissions and an independent named reviewer are required to confirm Offer-Acceptance Package." });
      return;
    }
    if (outcome.kind === "authority-evidence-missing") {
      res.status(409).json({ message: "Offer-Acceptance Package requires a current, pending authority-bound review. Historical or already-decided evidence cannot be retrofitted or replayed." });
      return;
    }
    if (outcome.kind === "not-applicable") {
      res.status(409).json({ message: "Offer-Acceptance Package is not applicable to this onboarding pathway." });
      return;
    }
    if (outcome.kind === "confirmed" && candidateEmailAuthorization(outcome.row).allowed) {
      await issueCandidatePortalLink({
        organizationId,
        caseId: id,
        issuedBy: req.authUserId!,
        publicBase: portalPublicBase(req),
        sendEmail: true,
        idempotencyKey: AUTOMATED_PORTAL_EMAIL_KEY(id),
      });
    }
    // Atomic case transition is the source of truth. If this process dies
    // before this wake-up, the shared heartbeat recovers offer-accepted rows.
    if (outcome.kind === "confirmed") startOrchestration(id);
    res.json(await serializeCaseForRequest(req, outcome.row));
  } catch (err) {
    next(err);
  }
});

/** Establish provenance for a pre-authority legacy case and queue only its
 * missing document-envelope recovery. This is an explicit admin action; no
 * historical requester is inferred. */
router.post("/onboarding/cases/:id/document-recovery", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Only organization owners and admins may initiate legacy document recovery.")) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [current] = await tx.select().from(onbCases).where(and(
        eq(onbCases.id, id), eq(onbCases.organizationId, organizationId),
      )).for("update");
      if (!current) return { kind: "not-found" as const };
      const access = await resolveEffectiveAccessInTransaction(tx, {
        organizationId,
        principalType: "human",
        principalId: req.authUserId!,
        caseId: id,
        purpose: "onboarding-document-recovery",
      });
      if (!access.allows.includes("data.documents.edit") ||
        !access.allows.includes("flow.document-review.edit")) {
        return { kind: "access-denied" as const };
      }
      // A completed case's historical record is immutable operational history;
      // recovery may not replay a provider operation against it.
      if (current.lifecycleStage === "complete") return { kind: "completed" as const };
      const documents = await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
        eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, id),
      )).limit(1);
      if (documents.length) return { kind: "already-recovered" as const };
      // Preserve the immutable historical creator exactly as recorded. The
      // authenticated recovery initiator is attached to the new approval,
      // never rewritten onto the old case.
      return { kind: "recoverable" as const };
    });
    if (outcome.kind === "completed") {
      res.status(409).json({ message: "Completed cases preserve their history and cannot replay document recovery." });
      return;
    }
    if (outcome.kind === "access-denied") {
      res.status(403).json({
        message: "Explicit document-edit and document-review edit grants are required to request document recovery.",
        code: "DOCUMENT_ACCESS_REQUIRED",
      });
      return;
    }
    if (outcome.kind !== "recoverable") {
      res.status(404).json({ message: "Active case with missing document pack not found." });
      return;
    }
    await createApproval({
      caseId: id, authorityScope: "legal-approve", agent: "workstreams",
      ruleRef: "Execution authorization — documents envelope",
      hitlPattern: "approve-before-act",
      recommendation: "Authorize recovery of the missing document envelope.",
      rationale: "A current legal specialist must authorize this missing document provider operation.",
      resumeAction: "recover-document-envelope",
      requestedByUserId: req.authUserId!,
      idempotencyKey: `orchestration:${id}:approval:execution:documents`,
    });
    res.status(202).json({ message: "Document recovery queued for legal approval." });
  } catch (err) { next(err); }
});

router.post("/onboarding/cases/:id/checklist-profile", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const body = RecalculateOnboardingChecklistProfileBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const id = Number(req.params.id);
    if (body.action === "replace-active" && !body.reason?.trim()) {
      res.status(400).json({ message: "A reason is required for deliberate replacement of an active transaction." });
      return;
    }
    const reviewer = await resolveReviewerName(req.authUserId!);
    const outcome = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
      await assertGovernanceMutationAllowed(tx, organizationId);
      await acquireCaseDispatchMutationLock(tx, organizationId, id);
      const [current] = await tx.select().from(onbCases).where(and(
        eq(onbCases.id, id),
        organizationWhere(onbCases, organizationId),
      )).for("update");
      if (!current) return { kind: "not-found" as const };
      const effectiveAccess = await resolveEffectiveAccessInTransaction(tx, {
        organizationId,
        principalType: "human",
        principalId: req.authUserId!,
        caseId: id,
        purpose: "onboarding-checklist-profile-replacement",
      });
      if (
        !effectiveAccess.allows.includes(CASE_FLOW_EDIT_KEY) ||
        !effectiveAccess.allows.includes(CASE_PROFILE_EDIT_KEY) ||
        !effectiveAccess.allows.includes("data.case.readiness.edit") ||
        (body.reason?.trim() && !effectiveAccess.allows.includes(CASE_NOTES_EDIT_KEY))
      ) {
        return { kind: "access-denied" as const };
      }
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId,
        jurisdiction: jurisdictionForWorkforceContext(current.workforceContext),
      });
      if (!lifecycle.allowed) return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
      await afterSensitiveLifecycleGateHookForTests?.("checklist-profile-replacement");
      if (
        current.checklistTemplateVersion !== body.expectedChecklistTemplateVersion ||
        current.checklistProfileId !== body.expectedChecklistProfileId ||
        (current.checklistProfileVersion ?? current.checklistTemplateVersion) !== body.expectedChecklistProfileVersion
      ) {
        return {
          kind: "conflict" as const,
          message: "The case checklist changed since it was loaded. Refresh the case before recalculating or replacing it.",
        };
      }
      if (await hasActiveCaseDispatchMarker(tx, organizationId, id)) {
        return {
          kind: "active-dispatch" as const,
          message: "This case has an active provider dispatch marker. Reconcile the dispatch before replacing its policy.",
        };
      }
      const initialPreOrchestration =
        current.orchestrationStatus === "idle" &&
        current.lifecycleStage === "trigger-received" &&
        current.orchestrationCheckpoint === null;
      const correctedPreworkstreamCandidate =
        current.lifecycleStage === "trigger-received" &&
        current.orchestrationCheckpoint === null &&
        (current.orchestrationStatus === "checklist-blocked" ||
          current.orchestrationStatus === "batch-intake-pending-review") &&
        current.orchestrationClaimOwner === null &&
        current.orchestrationClaimUntil === null &&
        current.checklistSnapshot.some((item) =>
          item.id === "policy-rebase-required" && item.enabled && item.mandatory,
        );
      // A context correction on a newly created case deliberately sets a
      // rebase gate while retaining its null checkpoint. It may be rebased
      // without a synthetic "active replacement" only if no human runtime
      // tasks, external effects, or orchestration claim were ever created.
      let correctedUnexecutedPreworkstream = false;
      let preserveBatchReview = false;
      if (correctedPreworkstreamCandidate) {
        // Keep these serial on the transaction connection. Besides avoiding
        // concurrent pg client calls, the order makes the no-task/no-effect
        // proof explicit before a historical batch hold is restored.
        const [runtime] = await tx.select({ key: onbSettings.key }).from(onbSettings).where(and(
          eq(onbSettings.organizationId, organizationId),
          eq(onbSettings.key, `operational_requests:${id}`),
        )).for("update").limit(1);
        const [priorEffect] = runtime
          ? []
          : await tx.select({ key: onbEffectJournal.logicalOperationKey }).from(onbEffectJournal).where(and(
              eq(onbEffectJournal.organizationId, organizationId),
              eq(onbEffectJournal.caseId, id),
            )).limit(1);
        if (!runtime && !priorEffect) {
          correctedUnexecutedPreworkstream = true;
          const [batchMembership] = await tx.select({
            batchId: onbIntakeBatchPeople.batchId,
          }).from(onbIntakeBatchPeople).where(and(
            eq(onbIntakeBatchPeople.organizationId, organizationId),
            eq(onbIntakeBatchPeople.caseId, id),
          )).limit(1);
          preserveBatchReview =
            current.orchestrationStatus === "batch-intake-pending-review" ||
            Boolean(batchMembership);
        }
      }
      const preOrchestration =
        initialPreOrchestration || correctedUnexecutedPreworkstream;
      await acquireChecklistPolicyLock(tx, organizationId);
      const workforcePolicy = await resolveEffectiveWorkforcePolicyInTransaction(
        tx,
        organizationId,
        current.workforceContext,
        current,
      );
      const { profile } = workforcePolicy;
      const recalculatedClassification = workforcePolicy.classification;
      const nextItems = workforcePolicy.effectiveItems;
      const readiness = mergeChecklistReadiness(nextItems, current.readiness, current.checklistSnapshot);
      const policyRebaseGateRemoved = !nextItems.some((item) =>
        item.id === "policy-rebase-required" && item.enabled && item.mandatory,
      );
      const unchanged =
        current.checklistTemplateVersion === profile.templateVersion &&
        current.checklistProfileId === profile.profileId &&
        current.checklistProfileVersion === profile.profileVersion &&
        JSON.stringify(current.checklistSnapshot) === JSON.stringify(nextItems);
      if (unchanged) return { kind: "updated" as const, row: current };
      if (!preOrchestration && body.action !== "replace-active") {
        return {
          kind: "conflict" as const,
          message: "Orchestration has begun. Use action \"replace-active\" for a deliberate audited replacement.",
        };
      }
      if (
        !preOrchestration &&
        (current.orchestrationStatus === "running" || current.orchestrationClaimOwner !== null)
      ) {
        return {
          kind: "conflict" as const,
          message: "This case currently has an active orchestration claim. Wait for it to pause before replacing the checklist.",
        };
      }
      const replacementDecision = preOrchestration
        ? { ok: true as const, forceReReview: false }
        : activeReplacementDecision(current, nextItems, readiness);
      if (!replacementDecision.ok) {
        return { kind: "conflict" as const, message: replacementDecision.reason };
      }
      const nextProcessPolicyBase = {
        profileId: profile.profileId, profileVersion: profile.profileVersion,
        templateVersion: profile.templateVersion, processPolicy: profile.processPolicy ?? {},
        classification: recalculatedClassification,
      };
      // Checklist/workforce policy replacement is not governance adoption.
      // Preserve the case's audited governance payload byte-for-byte (including
      // a legacy malformed/missing marker) rather than rewriting it.
      const existingPolicy = (current.processPolicySnapshot ?? {}) as Record<string, unknown>;
      const existingGovernanceSnapshot = governanceDecisionSnapshotFromPolicy(existingPolicy);
      const nextProcessPolicySnapshot = existingGovernanceSnapshot
        ? withGovernanceDecisionSnapshot(nextProcessPolicyBase, existingGovernanceSnapshot)
        : {
            ...nextProcessPolicyBase,
            ...(Object.prototype.hasOwnProperty.call(existingPolicy, "governanceDecisionSnapshot")
              ? { governanceDecisionSnapshot: structuredClone(existingPolicy.governanceDecisionSnapshot) }
              : {}),
          };
      if (JSON.stringify(current.processPolicySnapshot) !== JSON.stringify(nextProcessPolicySnapshot)) {
        if (!preOrchestration && !["initial", "plan", "intake-approved", "plan-approved", "blocked:before-workstreams"].includes(current.orchestrationCheckpoint ?? "")) {
          return { kind: "conflict" as const, message: "This process-policy change requires task initialization before workstreams. The case has passed that boundary; its existing task history and obligations are preserved." };
        }
        const [runtime] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
          eq(onbSettings.organizationId, organizationId),
          eq(onbSettings.key, `operational_requests:${id}`),
        )).for("update");
        if (runtime) {
          try { assertWorkforceRuntimeRebaseAllowed(runtime.value); }
          catch (error) { return { kind: "conflict" as const, message: error instanceof Error ? error.message : "Operational tasks prevent rebase." }; }
          // Preserve the retired requested state for audit rather than silently
          // discarding its task identities when the new policy is initialized.
          await tx.insert(onbSettings).values({
            organizationId,
            key: `retired_operational_requests:${id}:${current.workforceContextVersion}:${current.updatedAt.getTime()}`,
            value: runtime.value,
          });
          await tx.insert(onbEvents).values({
            organizationId, caseId: id, agent: "workforce-policy", engine: "rules",
            hitlPattern: "notify-only", ruleRef: "Version-fenced process policy rebase",
            title: "Requested process tasks retired before policy replacement",
            detail: "Requested process task state retained in the organization-scoped archive. New task initialization is required before workstreams.",
          });
          // Requested-only tasks are never effects. Retire their stale state so
          // the next safe workstream checkpoint initializes the new snapshot.
          await tx.delete(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, `operational_requests:${id}`)));
        }
      }
      const [row] = await tx.update(onbCases).set({
        checklistTemplateVersion: profile.templateVersion,
        checklistSnapshot: nextItems,
        checklistProfileId: profile.profileId,
        checklistProfileName: profile.profileName,
        checklistProfileVersion: profile.profileVersion,
        checklistMatchedCriteria: profile.matchedCriteria,
        checklistMatchExplanation: profile.explanation,
        workforceClassification: recalculatedClassification,
        processPolicySnapshot: {
          ...nextProcessPolicySnapshot,
          ...(readHroBatchRequest(current.processPolicySnapshot)
            ? { batchIntake: readHroBatchRequest(current.processPolicySnapshot) }
            : {}),
        },
        readiness,
        ...(correctedUnexecutedPreworkstream && policyRebaseGateRemoved
          ? {
              // Context correction must never turn a held cohort into a live
              // workflow. Restore an older corrected batch row to its explicit
              // hold; a manual newly-created case returns to idle but this
              // route never calls startOrchestration.
              orchestrationStatus: preserveBatchReview
                ? "batch-intake-pending-review" as const
                : "idle" as const,
              orchestrationCheckpoint: null,
              orchestrationClaimOwner: null,
              orchestrationClaimUntil: null,
            }
          : {}),
        ...(replacementDecision.forceReReview
          ? {
              lifecycleStage: "preboarding" as const,
              orchestrationStatus: "checklist-blocked" as const,
              orchestrationCheckpoint: "blocked:re-review",
              orchestrationClaimOwner: null,
              orchestrationClaimUntil: null,
            }
          : {}),
        updatedAt: new Date(),
      }).where(and(eq(onbCases.id, id), organizationWhere(onbCases, organizationId))).returning();
      await tx.insert(onbEvents).values({
        organizationId,
        caseId: id,
        agent: "hr-checklist-admin",
        engine: "human",
        hitlPattern: "approve-before-act",
        title: body.action === "replace-active" ? "Active checklist profile deliberately replaced" : "Checklist profile recalculated",
        detail: `${reviewer} (${req.authUserId}) changed ${current.checklistProfileName} v${current.checklistProfileVersion ?? current.checklistTemplateVersion} → ${profile.profileName} v${profile.profileVersion}.${body.reason ? ` Reason: ${body.reason.trim()}` : ""}${replacementDecision.forceReReview ? " Previously passed boundaries will not replay; the case was moved to a fresh mandatory-item review." : ""}`,
      });
      return { kind: "updated" as const, row };
    }));
    if (outcome.kind === "not-found") {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    if (outcome.kind === "access-denied") {
      res.status(403).json({
        message: "Explicit case-flow and case-profile edit grants (and case-notes edit for a reason) are required.",
        code: "CASE_EDIT_ACCESS_REQUIRED",
      });
      return;
    }
    if (outcome.kind === "conflict") {
      res.status(409).json({ message: outcome.message });
      return;
    }
    if (outcome.kind === "active-dispatch") {
      res.status(409).json({ message: outcome.message });
      return;
    }
    if (outcome.kind === "lifecycle-blocked") {
      res.status(409).json({ message: outcome.message });
      return;
    }
    res.json(await serializeCaseForRequest(req, outcome.row));
  } catch (err) {
    next(err);
  }
});

/**
 * Corrects captured job facts without silently changing the case policy.
 * The caller must subsequently use the fenced, audited profile replacement
 * action so no new requirement is introduced behind active orchestration.
 */
router.put("/onboarding/cases/:id/workforce-context", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ message: "A workforce-context correction object is required." });
      return;
    }
    const acceptedBodyFields = new Set(["workforceContext", "reason", "expectedUpdatedAt"]);
    const acceptedContextFields = new Set([
      "roleFamily", "band", "department", "legalEntity", "businessUnit", "industry",
      "workCountry", "workState", "site", "employmentArrangement", "workerCategory",
      "payBasis", "shiftPattern", "workEnvironment", "hazards", "requiredLicenses",
      "hiringMode", "batchId", "assistedIntake", "accessibilityNeeds", "languagePreference",
      "siteExposure", "safetyCritical",
    ]);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
    const context = body.workforceContext;
    if (
      Object.keys(body).some((key) => !acceptedBodyFields.has(key)) ||
      (context && typeof context === "object" && !Array.isArray(context) &&
        Object.keys(context).some((key) => !acceptedContextFields.has(key)))
    ) {
      res.status(400).json({ message: "Unknown workforce-context correction field." });
      return;
    }
    if (!Number.isInteger(id) || id < 1 || reason.length < 3 || reason.length > 500 ||
      !body.workforceContext || typeof body.workforceContext !== "object" || Array.isArray(body.workforceContext)) {
      res.status(400).json({ message: "A workforce context, current updatedAt value, and 3–500 character correction reason are required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const reviewer = await resolveReviewerName(req.authUserId!);
    let current: typeof onbCases.$inferSelect | undefined;
    let outcome;
    try {
      outcome = await withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
        organizationId,
        caseId: id,
        actorUserId: req.authUserId!,
        classification: "identity",
        additionalClassifications: ["medical", "payroll", "bgv"],
        additionalAccessKeys: [
          CASE_FLOW_EDIT_KEY, CASE_PROFILE_EDIT_KEY, CASE_NOTES_EDIT_KEY,
          "data.case.readiness.edit",
        ],
        beforeAuthorize: async (tx) => {
          await acquireCaseDispatchMutationLock(tx, organizationId, id);
          const [row] = await tx.select().from(onbCases).where(and(
            eq(onbCases.id, id), organizationWhere(onbCases, organizationId),
          )).for("update");
          if (!row) throw new WorkforceContextCorrectionPreconditionError("not-found");
          // Check the version before inspecting protected context or authority.
          // A stale caller always receives the ordinary conflict response.
          if (row.updatedAt.toISOString() !== expectedUpdatedAt) {
            throw new WorkforceContextCorrectionPreconditionError("conflict");
          }
          const readinessAccess = await resolveEffectiveAccessInTransaction(tx, {
            organizationId,
            principalType: "human",
            principalId: req.authUserId!,
            caseId: id,
            purpose: "onboarding-readiness-edit",
          });
          if (!readinessAccess.allows.includes("data.case.readiness.edit")) {
            throw new ReadinessGovernanceAccessRequiredError();
          }
          current = row;
          const sensitiveAccess = await resolveSensitiveAccessInTransaction(tx, {
            organizationId,
            caseId: id,
            actorUserId: req.authUserId,
          });
          // This is the same all-class predicate used by the case serializer
          // before exposing opaque workforce context.
          if (!hasOpaqueNarrativeAccess(sensitiveAccess)) {
            throw new SensitiveAuthorityRequiredError();
          }
        },
        mutateInTransaction: async (tx) => {
          const caseRow = current!;
          // Accessibility needs remain prohibited even for an authorized
          // caller. Keep the response generic so it reveals no hidden class.
          if (JSON.stringify(body.workforceContext).toLowerCase().includes("accessibilityneeds") ||
            JSON.stringify(caseRow.workforceContext).toLowerCase().includes("accessibilityneeds")) {
            return { kind: "restricted-context" as const };
          }
          if (caseRow.lifecycleStage === "complete") {
            return { kind: "terminal" as const };
          }
          if (await hasActiveCaseDispatchMarker(tx, organizationId, id)) {
            return { kind: "active-dispatch" as const };
          }
          if (caseRow.orchestrationStatus === "running" || caseRow.orchestrationClaimOwner !== null) {
            return { kind: "active-claim" as const };
          }
          const workforceContext = normalizedWorkforceContext(body.workforceContext as typeof caseRow.workforceContext);
          const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
            organizationId,
            jurisdiction: jurisdictionForWorkforceContext(workforceContext),
          });
          if (!lifecycle.allowed) return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
          const derived = classifyWorkforceContext(workforceContext);
          const workforceClassification = derived && {
            ...derived,
            source: "authorized-correction" as const,
            correction: { label: derived.label, by: reviewer, reason, at: new Date().toISOString() },
          };
          // A corrected context invalidates authority to continue with the old
          // execution snapshot. Require an explicit, fenced rebase before any
          // more connector effects; this is intentionally stricter than merely
          // changing the display classification.
          const reviewGate = {
            id: "policy-rebase-required",
            label: "Human policy rebase required after workforce context correction",
            order: caseRow.checklistSnapshot.length,
            enabled: true,
            mandatory: true,
            evidenceRequired: true,
            enforcementStage: "before-workstreams" as const,
            responsibleRole: "hr",
            completionAuthority: "designated-human" as const,
            executor: "human-task" as const,
          };
          const nextSnapshot = caseRow.checklistSnapshot.some((item) => item.id === reviewGate.id)
            ? caseRow.checklistSnapshot : [...caseRow.checklistSnapshot, reviewGate];
          const readiness = invalidateEvidenceReadinessForContextChange(
            nextSnapshot,
            mergeChecklistReadiness(nextSnapshot, caseRow.readiness, caseRow.checklistSnapshot),
          );
          const [row] = await tx.update(onbCases).set({
            workforceContext, workforceClassification, workforceContextVersion: caseRow.workforceContextVersion + 1, checklistSnapshot: nextSnapshot, readiness,
            // Context correction blocks further work but does not rewrite the
            // checkpoint reached by the original execution. Replacing it with a
            // pre-workstream checkpoint would allow a later rebase to erase the
            // already-crossed boundary.
            // Batch cases remain explicitly held. The rebase-required item still
            // blocks their release, but correction itself never converts cohort
            // review into ordinary checklist/orchestration progression.
            orchestrationStatus: caseRow.orchestrationStatus === "batch-intake-pending-review"
              ? "batch-intake-pending-review"
              : "checklist-blocked",
            orchestrationCheckpoint: caseRow.orchestrationCheckpoint,
            updatedAt: new Date(),
          })
            .where(and(eq(onbCases.id, id), organizationWhere(onbCases, organizationId))).returning();
          await tx.insert(onbEvents).values({
            organizationId, caseId: id, agent: "human", engine: "human", hitlPattern: "human-update",
            ruleRef: "Workforce context correction",
            title: "Authorized workforce context correction recorded",
            detail: `${reviewer} corrected captured job context. Policy snapshot was not changed; deliberate rebase is required. Reason: ${reason}`,
          });
          return { kind: "updated" as const, row };
        },
      }));
    } catch (error) {
      if (error instanceof WorkforceContextCorrectionPreconditionError) {
        if (error.kind === "not-found") return void res.status(404).json({ message: "Case not found." });
        return void res.status(409).json({ message: "Case changed since it was loaded. Refresh before correcting context." });
      }
      if (error instanceof ReadinessGovernanceAccessRequiredError) {
        return void res.status(403).json({
          message: error.message,
          code: "CASE_READINESS_ACCESS_REQUIRED",
        });
      }
      if (error instanceof SensitiveAuthorityRequiredError) {
        return void res.status(409).json({ message: RESTRICTED_WORKFORCE_CONTEXT_MESSAGE });
      }
      throw error;
    }
    if (!outcome) {
      return void res.status(409).json({ message: RESTRICTED_WORKFORCE_CONTEXT_MESSAGE });
    }
    if (outcome.kind === "restricted-context") {
      return void res.status(409).json({
        message: RESTRICTED_WORKFORCE_CONTEXT_MESSAGE,
      });
    }
    if (outcome.kind === "terminal") return void res.status(409).json({ message: "Completed cases are immutable; workforce context cannot be corrected after completion." });
    if (outcome.kind === "active-dispatch") return void res.status(409).json({ message: "This case has an active provider dispatch marker. Reconcile the dispatch before correcting workforce context." });
    if (outcome.kind === "active-claim") return void res.status(409).json({ message: "This case has an active orchestration claim. Wait for it to pause before correcting workforce context." });
    if (outcome.kind === "lifecycle-blocked") return void res.status(409).json({ message: outcome.message });
    res.json(await serializeCaseForRequest(req, outcome.row));
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/cases/:id/checklist/:itemId", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = UpdateOnboardingChecklistItemBody.parse(req.body);
    const result = await setCustomChecklistItemStatus({
      organizationId: getOrganizationId(req),
      caseId,
      itemId: String(req.params.itemId),
      status: body.status,
      note: body.note,
      reviewer: await resolveReviewerName(req.authUserId!),
      authorize: async (tx) => {
        const [specialist, access] = await Promise.all([
          hasCurrentAuthorityScope(tx, {
            organizationId: getOrganizationId(req), actorUserId: req.authUserId!,
            scope: "hr-compliance-approve", caseId,
          }),
          resolveEffectiveAccessInTransaction(tx, {
            organizationId: getOrganizationId(req),
            principalType: "human",
            principalId: req.authUserId!,
            caseId,
            purpose: "onboarding-readiness-edit",
          }),
        ]);
        return specialist && access.allows.includes("data.case.readiness.edit");
      },
    });
    if (!result.ok) {
      const messages = {
        "not-found": "Case or checklist item not found.",
        "not-custom": "Connector-managed checklist items cannot be changed manually.",
        disabled: "Disabled checklist items cannot be changed.",
        "evidence-required": "This independent evidence gate can only be completed through its designated evidence workflow; a manual toggle, reminder, or agent result is not accepted.",
        unauthorized: "Current approval-decision, case-flow and readiness-edit permissions are required to attest a checklist item.",
        "lifecycle-blocked": "This narrative update is blocked until all required sensitive-data lifecycle policies are approved for the case jurisdiction.",
      };
      res.status(
        result.code === "unauthorized"
          ? 403
          : result.code === "not-custom" || result.code === "disabled" || result.code === "evidence-required" || result.code === "lifecycle-blocked"
            ? 409
            : 404,
      )
        .json({ message: messages[result.code] });
      return;
    }
    res.json(await serializeCaseForRequest(req, result.case));
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/cases/:id/evidence/:itemId", async (req, res, next) => {
  try {
    // A designated HSE/occupational-health specialist must not need broad
    // owner/admin power. Tenant membership is enforced by organization
    // resolution; the evidence service verifies the narrower assignment.
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication required." });
      return;
    }
    const caseId = Number(req.params.id);
    const body = req.body as Record<string, unknown>;
    const evidenceReference = typeof body.evidenceReference === "string" ? body.evidenceReference.trim() : "";
    const authorityRole = typeof body.authorityRole === "string" ? body.authorityRole.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const decision = body.decision;
    const expected = body.expectedPolicy as Record<string, unknown> | undefined;
    if (!Number.isInteger(caseId) || caseId < 1 || evidenceReference.length < 3 || evidenceReference.length > 500 ||
      authorityRole.length < 2 || authorityRole.length > 80 || reason.length < 3 || reason.length > 500 ||
       (decision !== "verified" && decision !== "rejected") || !expected ||
       !Number.isInteger(expected.contextVersion) || !Number.isInteger(expected.templateVersion) ||
       typeof expected.profileId !== "string" || !Number.isInteger(expected.profileVersion)) {
      res.status(400).json({ message: "A valid evidence reference, configured authority role, decision, and 3–500 character reason are required." });
      return;
    }
    const result = await verifyChecklistEvidence({
      organizationId: getOrganizationId(req),
      caseId,
      itemId: String(req.params.itemId),
      evidenceReference,
      authorityRole,
      decision,
      reason,
      verifier: await resolveReviewerName(req.authUserId!),
      verifierUserId: req.authUserId!,
      authorizeAccess: async (tx) => {
        const access = await resolveEffectiveAccessInTransaction(tx, {
          organizationId: getOrganizationId(req),
          principalType: "human",
          principalId: req.authUserId!,
          caseId,
          purpose: "onboarding-readiness-edit",
        });
        return access.allows.includes("data.case.readiness.edit");
      },
      expected: { contextVersion: expected.contextVersion as number, templateVersion: expected.templateVersion as number, profileId: expected.profileId as string, profileVersion: expected.profileVersion as number },
    });
    if (!result.ok) {
      const messages = {
        "not-found": "Case or evidence gate not found.",
        "not-evidence-gate": "This checklist item is not an independently evidenced policy gate.",
        "wrong-authority": "The supplied authority does not match this gate's configured responsible role.",
        "not-designated": "Your account is not assigned as the designated authority for this policy gate.",
        "prerequisites-unmet": "This evidence gate has unmet prerequisites and cannot be verified yet.",
        "stale-policy": "The policy changed before this evidence was submitted. Refresh and submit against the current policy.",
        "lifecycle-blocked": "Evidence narratives are blocked until all required sensitive-data lifecycle policies are approved for the case jurisdiction.",
        "access-denied": "An explicit readiness-edit grant is required to record this evidence decision.",
      };
      res.status(result.code === "not-found" ? 404 : result.code === "access-denied" ? 403 : 409).json({ message: messages[result.code] });
      return;
    }
    res.json(await serializeCaseForRequest(req, result.case));
  } catch (err) {
    next(err);
  }
});

/** Owner/admin setup endpoint: authority is bound to a tenant member server-side. */
router.put("/onboarding/policy-authorities/:userId/:authorityRole", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    const userId = String(req.params.userId ?? "").trim();
    const authorityRole = canonicalAuthorityRoleId(String(req.params.authorityRole ?? ""));
    const scope = req.body as Record<string, unknown>;
    const caseId = Number(scope.caseId);
    const itemId = typeof scope.itemId === "string" ? scope.itemId.trim() : "";
    const site = typeof scope.site === "string" ? scope.site.trim() : "";
    if (!userId || !authorityRole || !Number.isInteger(caseId) || caseId < 1 || !itemId || !site) {
      res.status(400).json({ message: "A tenant user, stable role, and explicit case, item, and authority scope are required." });
      return;
    }
    const [caseRow] = await db.select({ workforceContext: onbCases.workforceContext })
      .from(onbCases).where(and(
        eq(onbCases.id, caseId),
        eq(onbCases.organizationId, organizationId),
      )).limit(1);
    if (!caseRow) {
      res.status(404).json({ message: "Case not found in this organization." });
      return;
    }
    const requiredScope = workforceAuthorityScope(caseRow.workforceContext);
    if (!requiredScope || site !== requiredScope) {
      res.status(400).json({ message: "Authority scope must exactly match the current case site, or use __organization__ only for a confirmed non-site office/remote context." });
      return;
    }
    const assigned = await db.transaction(async (tx) => {
      // Pair legacy policy-authority grants with membership revocation and
      // specialist authority grants on the same tenant fence.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [member] = await tx.select({ id: organizationMembershipsTable.id })
        .from(organizationMembershipsTable).where(and(
          eq(organizationMembershipsTable.organizationId, organizationId),
          eq(organizationMembershipsTable.clerkUserId, userId),
          isNull(organizationMembershipsTable.revokedAt),
        )).limit(1);
      if (!member) return false;
      await tx.insert(onbPolicyAuthorities).values({
        organizationId, userId, authorityRole, caseId, itemId, site,
        assignedBy: req.authUserId!,
      }).onConflictDoUpdate({
        target: [onbPolicyAuthorities.organizationId, onbPolicyAuthorities.userId, onbPolicyAuthorities.authorityRole, onbPolicyAuthorities.caseId, onbPolicyAuthorities.itemId, onbPolicyAuthorities.site],
        set: { revokedAt: null, assignedBy: req.authUserId! },
      });
      return true;
    });
    if (!assigned) {
      res.status(404).json({ message: "Authority must be assigned to an existing member of this organization." });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/onboarding/policy-authorities/:userId/:authorityRole", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const scope = req.body as Record<string, unknown>;
    const caseId = Number(scope.caseId);
    const itemId = typeof scope.itemId === "string" ? scope.itemId.trim() : "";
    const site = typeof scope.site === "string" ? scope.site.trim() : "";
    if (!Number.isInteger(caseId) || caseId < 1 || !itemId || !site) {
      return void res.status(400).json({ message: "Explicit case, item, and site scope are required to revoke an authority assignment." });
    }
    const [revoked] = await db.update(onbPolicyAuthorities).set({ revokedAt: new Date() }).where(and(
      eq(onbPolicyAuthorities.organizationId, getOrganizationId(req)),
      eq(onbPolicyAuthorities.userId, String(req.params.userId)),
      eq(onbPolicyAuthorities.authorityRole, canonicalAuthorityRoleId(String(req.params.authorityRole)) ?? ""),
      eq(onbPolicyAuthorities.caseId, caseId),
      eq(onbPolicyAuthorities.itemId, itemId),
      eq(onbPolicyAuthorities.site, site),
      isNull(onbPolicyAuthorities.revokedAt),
    )).returning({ userId: onbPolicyAuthorities.userId });
    if (!revoked) return void res.status(404).json({ message: "Active authority assignment not found." });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Deliberately returns only stable tenant identities and membership roles for
 * assignment controls; names/emails are not invented or used as authority IDs. */
router.get("/onboarding/members", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const members = await db.select({
      userId: organizationMembershipsTable.clerkUserId,
      role: organizationMembershipsTable.role,
    }).from(organizationMembershipsTable).where(
      and(
        eq(organizationMembershipsTable.organizationId, getOrganizationId(req)),
        isNull(organizationMembershipsTable.revokedAt),
      ),
    ).orderBy(organizationMembershipsTable.clerkUserId);
    res.json(members);
  } catch (err) { next(err); }
});

router.get("/onboarding/job-profiles", async (req, res, next) => {
  try {
    const rows = await db.select().from(onbJobProfiles)
      .where(eq(onbJobProfiles.organizationId, getOrganizationId(req)))
      .orderBy(onbJobProfiles.profileId, desc(onbJobProfiles.version));
    const seen = new Set<string>();
    res.json(rows.filter((row) => !seen.has(row.profileId) && Boolean(seen.add(row.profileId))));
  } catch (err) { next(err); }
});

/** Server-side selection preview for a concrete proposed job context.  This
 * uses the same resolver and priority ordering as enrollment; it is not a
 * checklist-only client approximation. */
router.post("/onboarding/checklist-profiles/preview", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const text = (key: string, fallback = "") => typeof body[key] === "string" ? body[key].trim() : fallback;
    const nestedContext = body.workforceContext && typeof body.workforceContext === "object" &&
      !Array.isArray(body.workforceContext)
      ? body.workforceContext as Record<string, unknown>
      : {};
    const contextText = (key: string) => typeof nestedContext[key] === "string"
      ? nestedContext[key].trim()
      : text(key);
    const triStateBoolean = (key: "siteExposure" | "safetyCritical") => {
      const value = nestedContext[key] ?? body[key];
      if (value === true || value === "true") return true;
      if (value === false || value === "false") return false;
      // Blank, omitted, or malformed input is unknown. Never infer false.
      return undefined;
    };
    const workEnvironment = contextText("workEnvironment");
    const hiringMode = contextText("hiringMode");
    const workforceContext = normalizedWorkforceContext({
      roleFamily: contextText("roleFamily") || undefined,
      band: contextText("band") || undefined,
      department: contextText("department") || undefined,
      legalEntity: contextText("legalEntity") || undefined,
      businessUnit: contextText("businessUnit") || undefined,
      industry: contextText("industry") || undefined,
      workCountry: contextText("workCountry") || undefined,
      workState: contextText("workState") || undefined,
      site: contextText("site") || undefined,
      employmentArrangement: contextText("employmentArrangement") || undefined,
      workerCategory: contextText("workerCategory") || undefined,
      payBasis: contextText("payBasis") || undefined,
      shiftPattern: contextText("shiftPattern") || undefined,
      workEnvironment: ["office", "remote", "site", "field", "mixed"].includes(workEnvironment)
        ? workEnvironment as "office" | "remote" | "site" | "field" | "mixed"
        : undefined,
      hiringMode: ["individual", "batch", "seasonal"].includes(hiringMode)
        ? hiringMode as "individual" | "batch" | "seasonal"
        : undefined,
      siteExposure: triStateBoolean("siteExposure"),
      safetyCritical: triStateBoolean("safetyCritical"),
    });
    const attributes = checklistProfileMatchingAttributes(workforceContext, {
      workerBand: text("band") || null,
      role: text("role"),
      hireType: text("employmentType"),
      workerCategory: text("workerCategory") || null,
      geography: text("location"),
      department: text("department") || null,
      legalEntity: text("legalEntity") || null,
    });
    if (!attributes.role || !attributes.employmentType || !attributes.location) {
      return void res.status(400).json({ message: "Sample role, employment type, and location are required for an actual selection preview." });
    }
    const result = await resolveEffectiveWorkforcePolicy(
      getOrganizationId(req),
      workforceContext,
      {
        workerBand: text("band") || null,
        role: text("role"),
        hireType: text("employmentType"),
        workerCategory: text("workerCategory") || null,
        geography: text("location"),
        department: text("department") || null,
        legalEntity: text("legalEntity") || null,
      },
    );
    res.json({
      sampleContext: result.attributes,
      classification: result.classification,
      effectiveItems: result.effectiveItems,
      selection: { ...result.profile, items: result.effectiveItems },
    });
  } catch (err) { next(err); }
});

router.post("/onboarding/job-profiles", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const profileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : randomUUID();
    if (!name || name.length > 120 || !body.context || typeof body.context !== "object" || Array.isArray(body.context)) {
      res.status(400).json({ message: "A name and explicit job context are required." }); return;
    }
    const organizationId = getOrganizationId(req);
    const existing = await db.select({ version: onbJobProfiles.version }).from(onbJobProfiles).where(and(
      eq(onbJobProfiles.organizationId, organizationId), eq(onbJobProfiles.profileId, profileId),
    )).orderBy(desc(onbJobProfiles.version)).limit(1);
    if (existing[0] && body.expectedVersion !== existing[0].version) {
      res.status(409).json({ message: `Job profile changed since it was loaded (current version ${existing[0].version}).` }); return;
    }
    const [row] = await db.insert(onbJobProfiles).values({
      organizationId, profileId, version: (existing[0]?.version ?? 0) + 1, name,
      context: normalizedWorkforceContext(body.context as any), enabled: body.enabled !== false,
      createdBy: req.authUserId!,
    }).returning();
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get("/onboarding/cases/:id/events", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [exists] = await db.select({
      id: onbCases.id,
      notes: onbCases.notes,
      syntheticProvenance: onbCases.syntheticProvenance,
      workerName: onbCases.workerName,
      workerEmail: onbCases.workerEmail,
      workerPhone: onbCases.workerPhone,
    }).from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!exists) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const caseAccess = await caseGovernanceAccessForRequest(req, {
      organizationId: getOrganizationId(req),
      id,
    });
    if (!caseFlowReadRequired(res, caseAccess)) return;
    const rows = await db
      .select()
      .from(onbEvents)
      .where(and(
        eq(onbEvents.caseId, id),
        eq(onbEvents.organizationId, getOrganizationId(req)),
      ))
      .orderBy(asc(onbEvents.createdAt), asc(onbEvents.id));
    res.json(await Promise.all(rows.map((row) => serializeEventForRequest(req, row))));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/communications", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [caseRow] = await db.select({
      id: onbCases.id,
      workerEmail: onbCases.workerEmail,
      notes: onbCases.notes,
      scenarioKey: onbCases.scenarioKey,
      syntheticProvenance: onbCases.syntheticProvenance,
      candidateEmailAuthorizedAt: onbCases.candidateEmailAuthorizedAt,
      candidateEmailAuthorizedBy: onbCases.candidateEmailAuthorizedBy,
    }).from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!caseRow) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const caseAccess = await caseGovernanceAccessForRequest(req, {
      organizationId: getOrganizationId(req),
      id,
    });
    if (!caseFlowReadRequired(res, caseAccess)) return;
    const rows = await db
      .select()
      .from(onbCommunications)
      .where(and(
        eq(onbCommunications.caseId, id),
        eq(onbCommunications.organizationId, getOrganizationId(req)),
      ))
      .orderBy(asc(onbCommunications.createdAt), asc(onbCommunications.id));
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId: id,
      actorUserId: req.authUserId,
    });
    const fictionalOfflineCase =
      getOrganizationId(req) === DEMO_ORGANIZATION_ID &&
      caseRow.candidateEmailAuthorizedAt === null &&
      caseRow.candidateEmailAuthorizedBy === null &&
      isExplicitSyntheticDemoCase(caseRow);
    if (
      fictionalOfflineCase &&
      caseAccess.notesRead &&
      caseAccess.profileRead &&
      !hasOpaqueNarrativeAccess(sensitiveAccess)
    ) {
      const simulationRows = rows.filter((row) =>
        row.channel === "simulation" &&
        row.idempotencyKey?.startsWith(`case-simulation:${id}:`),
      );
      res.json(simulationRows.map((row) => ({
        id: row.id,
        caseId: row.caseId,
        channel: "simulation",
        direction: row.direction,
        audience: "internal",
        status: row.status,
        sensitive: false,
        subject: "Response-driven simulation",
        body: "A synthetic simulation exchange was recorded. Candidate, recipient, and provider details are not included in this view.",
        createdAt: row.createdAt.toISOString(),
      })));
      return;
    }
    res.json(rows.map((r) => {
      // Subjects, bodies, and delivery failures are opaque narratives even
      // when an older record carries a candidate-contact/voice label. Labels
      // are not content classification and a single specialist must not gain
      // access to a mixed candidate disclosure by a keyword match.
      const restricted = !caseAccess.notesRead ||
        !caseAccess.profileRead ||
        !hasOpaqueNarrativeAccess(sensitiveAccess);
      if (restricted) {
        return {
          id: r.id,
          caseId: r.caseId,
          channel: r.channel,
          direction: r.direction,
          audience: r.audience,
          status: r.status,
          sensitive: true,
          subject: "Restricted confidential onboarding communication",
          body: "Details are restricted to the assigned specialist.",
          createdAt: r.createdAt.toISOString(),
        };
      }
      return {
        id: r.id,
        caseId: r.caseId,
        channel: r.channel,
        direction: r.direction,
        audience: r.audience,
        toAddress: r.toAddress,
        subject: r.subject,
        body: r.body,
        status: r.status,
        failureReason: r.audience === "candidate" && r.channel === "email"
          ? candidateEmailFailureFeedback(caseRow.workerEmail, r.failureReason, r.status)
          : r.failureReason,
        sensitive: r.sensitive,
        sensitiveDataClass: r.sensitiveDataClass,
        externalMessageId: r.externalMessageId,
        idempotencyKey: r.idempotencyKey,
        retriedAt: r.retriedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }));
  } catch (err) {
    next(err);
  }
});

/* ----------------------- BGV stakeholder notices ----------------------- */

router.get("/onboarding/cases/:caseId/bgv-notifications", async (req, res, next) => {
  try {
    const { caseId } = GetOnboardingBgvNotificationsParams.parse(req.params);
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, ["bgv"])) {
      res.status(403).json({
        message: "BGV notification recipients and review history are restricted to an assigned HR/compliance specialist.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    const result = await getBgvNotifications({
      organizationId: getOrganizationId(req),
      caseId,
      role: req.organizationRole,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof BgvNotificationNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.put("/onboarding/cases/:caseId/bgv-notifications", async (req, res, next) => {
  try {
    const { caseId } = GetOnboardingBgvNotificationsParams.parse(req.params);
    const body = parseBgvNotificationUpdateBody(req.body);
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, ["bgv"], "edit")) {
      res.status(403).json({
        message: "Current decision, case-flow and applicable sensitive-field edit permissions are required to change BGV recipients.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    if (!canManageBgvNotifications(getOrganizationId(req), req.organizationRole)) {
      res.status(403).json({
        message: "Owner or admin HR role required for BGV recipient configuration; Demo Organization members may save simulation-only configuration.",
      });
      return;
    }
    const result = await withSensitiveAuthorityFence({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId!,
      classification: "bgv",
      mutate: () => updateBgvNotifications({
        organizationId: getOrganizationId(req),
        caseId,
        role: req.organizationRole,
        version: body.version,
        config: body.config,
      }),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current decision, case-flow and applicable sensitive-field edit permissions are required to change BGV recipients.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    if (error instanceof BgvNotificationNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof BgvNotificationValidationError) {
      res.status(400).json({ message: error.message });
      return;
    }
    if (error instanceof BgvNotificationConflictError) {
      res.status(409).json({
        message: error.message,
        ...(error.currentVersion === undefined ? {} : { version: error.currentVersion }),
      });
      return;
    }
    next(error);
  }
});

router.post("/onboarding/cases/:caseId/bgv-notifications/reconcile", async (req, res, next) => {
  try {
    const { caseId } = GetOnboardingBgvNotificationsParams.parse(req.params);
    const body = ReconcileOnboardingBgvNotificationsBody.parse(req.body ?? {});
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, ["bgv"], "edit")) {
      res.status(403).json({
        message: "Current decision, case-flow and applicable sensitive-field permissions are required to reconcile BGV notifications.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    if (!canManageBgvNotifications(getOrganizationId(req), req.organizationRole)) {
      res.status(403).json({
        message: "Owner or admin HR role required to reconcile BGV notifications; Demo Organization members may reconcile simulation-only notices.",
      });
      return;
    }
    const result = await withSensitiveAuthorityFence({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId!,
      classification: "bgv",
      additionalAccessKeys: body.simulation || getOrganizationId(req) === DEMO_ORGANIZATION_ID
        ? []
        : ["tool.notification.send"],
      mutate: () => reconcileBgvNotifications({
        organizationId: getOrganizationId(req),
        caseId,
        role: req.organizationRole,
        reason: "manual",
        simulation: body.simulation || getOrganizationId(req) === DEMO_ORGANIZATION_ID,
      }),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current decision, case-flow and applicable sensitive-field permissions are required to reconcile BGV notifications.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    if (error instanceof BgvNotificationNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof BgvNotificationConflictError) {
      res.status(409).json({
        message: error.message,
        ...(error.currentVersion === undefined ? {} : { version: error.currentVersion }),
      });
      return;
    }
    next(error);
  }
});

router.get("/onboarding/agents", (req, res, next) => {
  try {
    // The catalog is intentionally the same for every tenant, but this route
    // remains behind the authenticated tenant router boundary. Touching the
    // tenant context here makes that contract explicit without persisting
    // tenant-specific catalog copies.
    getOrganizationId(req);
    res.json(getOnboardingAgentCatalog());
  } catch (error) {
    next(error);
  }
});

router.get("/onboarding/cases/:caseId/operational-requests", async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const result = await getOperationalRequests(organizationId, caseId);
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    res.json({
      ...result,
      requests: result.requests.map((request) => request.id.startsWith("payroll") && !sensitiveAccess.payroll
        ? {
            id: request.id,
            label: "Restricted payroll workstream",
            status: request.status,
            restricted: true,
          }
        : request),
    });
  } catch (error) {
    if (error instanceof OperationalRequestNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof OperationalRequestConflictError) {
      res.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post("/onboarding/cases/:caseId/operational-requests", async (req, res, next) => {
  try {
    if (!requireOperationalMutationRole(req, res)) return;
    const caseId = Number(req.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const body = InitializeOnboardingOperationalRequestsBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const initialize = async () => initializeOperationalRequests({
      organizationId,
      caseId,
      method: body.method,
      requestIds: body.requestIds,
      requestId: body.requestId,
      expectedVersion: body.expectedVersion,
      actor: await resolveReviewerName(req.authUserId!),
    });
    const [caseScope] = await db.select({
      notes: onbCases.notes,
      scenarioKey: onbCases.scenarioKey,
      syntheticProvenance: onbCases.syntheticProvenance,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId),
      eq(onbCases.id, caseId),
    )).limit(1);
    const result = caseScope && !isSyntheticOfflineCase(caseScope)
      ? await withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
        organizationId,
        caseId,
        actorUserId: req.authUserId!,
        classification: "payroll",
        additionalAccessKeys: ["tool.workflow.run"],
        mutate: initialize,
      }))
      : await initialize();
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    res.json({
      ...result,
      requests: result.requests.map((request) => request.id.startsWith("payroll") && !sensitiveAccess.payroll
        ? {
            id: request.id,
            label: "Restricted payroll workstream",
            status: request.status,
            restricted: true,
          }
        : request),
    });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current approval-decision, case-flow and payroll edit permissions are required.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    if (error instanceof OperationalRequestNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    if (
      error instanceof OperationalRequestConflictError ||
      error instanceof OperationalRequestOfflineError
    ) {
      res.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post("/onboarding/cases/:caseId/operational-requests/:requestId/actions", async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." });
      return;
    }
    const operationalRequestId = String(req.params.requestId);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(operationalRequestId)) {
      res.status(400).json({ message: "Valid operational request id is required." });
      return;
    }
    const body = ApplyOnboardingOperationalRequestActionBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const apply = async () => applyOperationalRequestAction({
      organizationId,
      caseId,
      operationalRequestId,
      requestId: body.requestId,
      action: body.action,
      method: body.method,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      actor: await resolveReviewerName(req.authUserId!),
      actorUserId: req.authUserId!,
      organizationRole: req.organizationRole,
    });
    const result = operationalRequestId.startsWith("payroll")
      ? await withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
        organizationId,
        caseId,
        actorUserId: req.authUserId!,
        classification: "payroll",
        additionalAccessKeys: [
          "tool.workflow.run",
          ...(body.action === "complete" ? ["tool.external.dispatch"] : []),
        ],
        mutate: apply,
      }))
      : await apply();
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    res.json({
      ...result,
      requests: result.requests.map((request) => request.id.startsWith("payroll") && !sensitiveAccess.payroll
        ? {
            id: request.id,
            label: "Restricted payroll workstream",
            status: request.status,
            restricted: true,
          }
        : request),
    });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current approval-decision, case-flow and payroll edit permissions are required.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    if (error instanceof OperationalRequestNotFoundError) {
      res.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof OperationalRequestAuthorizationError) {
      res.status(403).json({ message: error.message });
      return;
    }
    if (
      error instanceof OperationalRequestConflictError ||
      error instanceof OperationalRequestOfflineError
    ) {
      res.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post("/onboarding/cases/:id/offer-package-request", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    if (!Number.isSafeInteger(caseId) || caseId < 1) {
      res.status(400).json({ message: "Valid case id is required." }); return;
    }
    const organizationId = getOrganizationId(req);
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
    ));
    if (!c) { res.status(404).json({ message: "Case not found" }); return; }
    if (!offerAcceptanceRequired(c) || c.offerAcceptanceComplete) {
      res.status(409).json({ message: "An offer-package request is not needed for this case." }); return;
    }
    const delivery = await withSensitiveAuthorityFence({
      organizationId, caseId, actorUserId: req.authUserId!,
      classification: "identity",
      additionalClassifications: ["medical", "payroll", "bgv"],
      additionalAccessKeys: ["tool.notification.send"],
      mutate: () => requestOfferPackageEmail(caseId),
    });
    res.json(delivery);
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current case-scoped sensitive authority is required to request candidate email." }); return;
    }
    if (error instanceof SensitiveLifecyclePermissionError) {
      res.status(403).json({ message: error.message }); return;
    }
    if (error instanceof Error && /retained TA acceptance evidence/.test(error.message)) {
      res.status(409).json({ message: error.message }); return;
    }
    next(error);
  }
});

router.post("/onboarding/cases/:id/communications/:communicationId/retry", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const communicationId = Number(req.params.communicationId);
    if (!Number.isInteger(caseId) || !Number.isInteger(communicationId)) {
      res.status(400).json({ message: "Valid case and communication ids are required." });
      return;
    }
    const [ownedCase] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(and(
        eq(onbCases.id, caseId),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    if (!ownedCase) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    // Retrying replays a stored outbound message. Treat that as a disclosure
    // operation rather than a harmless status update: tenant membership and
    // display role are not sufficient authority for candidate-contact data.
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, ["identity"], "edit")) {
      res.status(403).json({
        message: "A current HR/compliance authority assignment is required to retry a candidate communication.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    const reviewer = await resolveReviewerName(req.authUserId!);
    const result = await withSensitiveAuthorityFence({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId!,
      classification: "identity",
      additionalAccessKeys: ["tool.notification.send"],
      mutate: () => retryCandidateEmail(caseId, communicationId, reviewer),
    });
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : result.code === "not-retryable" ? 409 : 403;
      res.status(status).json({ message: result.reason });
      return;
    }
    const row = result.communication;
    // The send result is deliberately a status receipt, not a copy of the
    // message body or provider failure detail.
    res.json({
      id: row.id,
      caseId: row.caseId,
      status: row.status,
      retriedAt: iso(row.retriedAt),
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "A current HR/compliance authority assignment is required to retry a candidate communication.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
      return;
    }
    next(err);
  }
});

router.get("/onboarding/cases/:id/documents", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [exists] = await db.select({ id: onbCases.id }).from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!exists) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const caseAccess = await caseGovernanceAccessForRequest(req, {
      organizationId: getOrganizationId(req),
      id,
    });
    if (!caseAccess.documentsRead) {
      res.status(403).json({
        message: "An explicit document-read grant is required to view case documents.",
        code: "DOCUMENT_ACCESS_REQUIRED",
      });
      return;
    }
    const rows = await listDocuments(id);
    const uploads = await db.select({
      id: onbCandidateUploads.id,
      documentId: onbCandidateUploads.documentId,
      checksumSha256: onbCandidateUploads.checksumSha256,
      malwareScanState: onbCandidateUploads.malwareScanState,
      malwareScanSha256: onbCandidateUploads.malwareScanSha256,
    }).from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.caseId, id),
      eq(onbCandidateUploads.organizationId, getOrganizationId(req)),
    )).orderBy(desc(onbCandidateUploads.id));
    const latestUploads = new Map<number, typeof uploads[number]>();
    for (const upload of uploads) if (!latestUploads.has(upload.documentId)) latestUploads.set(upload.documentId, upload);
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId: id,
      actorUserId: req.authUserId,
    });
    res.json(
      rows.map((r) => {
        const latest = latestUploads.get(r.id);
        const securityBlocked = !!latest && !malwareUploadIsClean(latest);
        const status = securityBlocked && r.status === "verified" ? "received" : r.status;
        return restrictedDocumentView({
          id: r.id,
          caseId: r.caseId,
          key: r.key,
          label: r.label,
          category: r.category,
          status,
          required: r.required,
          note: securityBlocked ? "Security scan must be clean before this document can be verified." : r.note,
          reminderCount: r.reminderCount,
          lastReminderAt: iso(r.lastReminderAt),
          reminderNextAt: iso(r.reminderNextAt),
          updatedAt: r.updatedAt.toISOString(),
        }, sensitiveAccess);
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Tenant-scoped evidence view: object paths and raw provider details are never returned. */
router.get("/onboarding/cases/:id/evidence", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const organizationId = getOrganizationId(req);
    const [owned] = await db.select({ id: onbCases.id }).from(onbCases)
      .where(and(eq(onbCases.id, caseId), organizationWhere(onbCases, organizationId)));
    if (!owned) return res.status(404).json({ message: "Case not found" });
    const caseAccess = await caseGovernanceAccessForRequest(req, {
      organizationId,
      id: caseId,
    });
    if (!caseAccess.documentsRead || !caseAccess.documentReviewRead) {
      return res.status(403).json({
        message: "Explicit document-read and document-review read grants are required to view review evidence.",
        code: "DOCUMENT_ACCESS_REQUIRED",
      });
    }
    const rows = await db.select({
      id: onbCandidateUploads.id, documentId: onbCandidateUploads.documentId,
      originalName: onbCandidateUploads.originalName, contentType: onbCandidateUploads.contentType,
      sizeBytes: onbCandidateUploads.sizeBytes, checksumSha256: onbCandidateUploads.checksumSha256,
      validationState: onbCandidateUploads.validationState, validationReasons: onbCandidateUploads.validationReasons,
      validationStartedAt: onbCandidateUploads.validationStartedAt, validatedAt: onbCandidateUploads.validatedAt,
      malwareScanState: onbCandidateUploads.malwareScanState,
      malwareScannedAt: onbCandidateUploads.malwareScannedAt,
      malwareScanSha256: onbCandidateUploads.malwareScanSha256,
      key: onbDocuments.key, label: onbDocuments.label, category: onbDocuments.category, required: onbDocuments.required,
      reminderCount: onbDocuments.reminderCount, reminderNextAt: onbDocuments.reminderNextAt,
    }).from(onbCandidateUploads).innerJoin(onbDocuments, and(eq(onbDocuments.id, onbCandidateUploads.documentId), eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId))).where(and(eq(onbCandidateUploads.caseId, caseId), eq(onbCandidateUploads.organizationId, organizationId))).orderBy(desc(onbCandidateUploads.id));
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    const latestByDocument = new Map<number, typeof rows[number]>();
    for (const row of rows) if (!latestByDocument.has(row.documentId)) latestByDocument.set(row.documentId, row);
    const canReadNarratives = hasOpaqueNarrativeAccess(sensitiveAccess);
    return res.json(rows.map(({ checksumSha256, malwareScanSha256, originalName, validationReasons, key, ...row }) => {
      const classes = sensitiveClassForDocument({ key, ...row });
      if (!hasSensitiveAccess(sensitiveAccess, classes)) {
        return {
          id: row.id,
          documentId: row.documentId,
          label: "Restricted confidential document evidence",
          category: "restricted",
          restricted: true,
          validationState: "restricted",
          malwareScanState: "restricted",
          canReview: false,
          canRequestCorrection: false,
          canRetryScan: false,
        };
      }
      const isLatest = latestByDocument.get(row.documentId)?.id === row.id;
      const canEdit = hasSensitiveAccess(sensitiveAccess, classes, "edit");
      const malwareClean = malwareUploadIsClean({ malwareScanState: row.malwareScanState, checksumSha256, malwareScanSha256 });
      return {
        ...row,
        originalName: canReadNarratives ? originalName : "Restricted confidential filename.",
        validationReasons: canReadNarratives
          ? validationReasons
          : [{ code: "restricted", message: "Validation details are restricted to the assigned confidential-record reviewers." }],
        fingerprint: checksumSha256?.slice(0, 12) ?? null,
        malwareScannedAt: iso(row.malwareScannedAt),
        malwareClean,
        isLatest,
        canReview: canEdit && isLatest && ["manual_review", "correction_requested"].includes(row.validationState) && malwareClean,
        canRequestCorrection: canEdit && isLatest && (
          ["manual_review", "correction_requested"].includes(row.validationState) ||
          (!malwareClean && row.validationState !== "rejected")
        ),
        canRetryScan: canEdit && isLatest && malwareScanCanRetry(row.malwareScanState),
      };
    }));
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      return res.status(403).json({ message: "Current document-tool, flow and applicable sensitive-field edit permissions are required to requeue this scan.", code: "SENSITIVE_RECORD_ACCESS_REQUIRED" });
    }
    return next(error);
  }
});

router.post("/onboarding/cases/:id/evidence/:evidenceId/decision", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    const organizationId = getOrganizationId(req);
    const body = DecideOnboardingEvidenceBody.parse(req.body);
    const decision = body.decision;
    const reason = body.reason.trim();
    const state = decision === "approve" ? "passed" : decision === "reject" ? "rejected" : "correction_requested";
    const [target] = await db.select({
      documentId: onbCandidateUploads.documentId,
      key: onbDocuments.key,
      label: onbDocuments.label,
      category: onbDocuments.category,
    }).from(onbCandidateUploads).innerJoin(onbDocuments, and(
      eq(onbDocuments.id, onbCandidateUploads.documentId),
      eq(onbDocuments.organizationId, organizationId),
      eq(onbDocuments.caseId, caseId),
    )).where(and(
      eq(onbCandidateUploads.id, evidenceId),
      eq(onbCandidateUploads.caseId, caseId),
      eq(onbCandidateUploads.organizationId, organizationId),
    ));
    if (!target) return res.status(404).json({ message: "Evidence not found" });
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    const sensitiveClasses = sensitiveClassForDocument(target);
    if (!hasSensitiveAccess(sensitiveAccess, sensitiveClasses, "edit")) {
      return res.status(403).json({
        message: "Current document-review, case-flow and applicable sensitive-field edit permissions are required to decide this document.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
    }
    const result = await withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
      organizationId,
      caseId,
      actorUserId: req.authUserId!,
      classification: sensitiveClasses[0]!,
      additionalClassifications: sensitiveClasses.slice(1),
      additionalAccessKeys: [
        "tool.documents.edit",
        "data.documents.edit",
        "flow.document-review.edit",
        "data.case.readiness.edit",
      ],
      mutate: () => db.transaction(async (tx) => {
      const [caseRow] = await tx.select({ workforceContext: onbCases.workforceContext })
        .from(onbCases).where(and(
          eq(onbCases.id, caseId),
          eq(onbCases.organizationId, organizationId),
        )).for("update");
      if (!caseRow) return { kind: "not_found" as const };
      const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
        organizationId,
        jurisdiction: jurisdictionForWorkforceContext(caseRow.workforceContext),
      });
      if (!lifecycle.allowed) return { kind: "lifecycle-blocked" as const, message: lifecycle.reason };
      await afterSensitiveLifecycleGateHookForTests?.("evidence-decision");
      // Keep the lock order identical to candidate replacement and worker
      // transitions: document first, then the upload row(s).
      await tx.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
        eq(onbDocuments.id, target.documentId),
        eq(onbDocuments.caseId, caseId),
        eq(onbDocuments.organizationId, organizationId),
      )).for("update");
      const [upload] = await tx.select().from(onbCandidateUploads).where(and(
        eq(onbCandidateUploads.id, evidenceId), eq(onbCandidateUploads.caseId, caseId), eq(onbCandidateUploads.organizationId, organizationId),
      )).for("update");
      if (!upload) return { kind: "not_found" as const };
      const [latest] = await tx.select({ id: onbCandidateUploads.id }).from(onbCandidateUploads).where(and(
        eq(onbCandidateUploads.documentId, upload.documentId),
        eq(onbCandidateUploads.caseId, caseId),
        eq(onbCandidateUploads.organizationId, organizationId),
      )).orderBy(desc(onbCandidateUploads.id)).limit(1).for("update");
      if (!latest || latest.id !== upload.id) return { kind: "stale" as const };
      const malwareClean = malwareUploadIsClean(upload);
      if (!["manual_review", "correction_requested"].includes(upload.validationState)
        && !(decision === "request_correction" && !malwareClean && upload.validationState !== "rejected")) {
        return { kind: "not_reviewable" as const };
      }
      if (decision === "approve") {
        if (!malwareClean) return { kind: "malware_blocked" as const };
      }
      const [row] = await tx.update(onbCandidateUploads).set({
        validationState: state, validationReasons: [{ code: "hr_decision", message: reason }],
        validatedAt: new Date(), validationClaimOwner: null, validationClaimUntil: null,
      }).where(and(eq(onbCandidateUploads.id, evidenceId), eq(onbCandidateUploads.organizationId, organizationId), eq(onbCandidateUploads.caseId, caseId))).returning();
      if (!row) throw new Error("Evidence decision lost its ownership fence");
      await tx.update(onbDocuments).set({
        status: decision === "approve" ? "verified" : "received",
        note: decision === "approve" ? "Accepted by HR after manual review." : reason,
        reminderNextAt: decision === "approve" ? null : new Date(),
        updatedAt: new Date(),
      }).where(and(eq(onbDocuments.id, upload.documentId), eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId)));
      await tx.insert(onbEvents).values({
        organizationId, caseId, agent: "hr-reviewer", engine: "human", hitlPattern: "approve-before-act",
        ruleRef: "document-validation-manual-review", title: `Document ${decision.replace("_", " ")}`,
        detail: reason, idempotencyKey: `document-decision:${evidenceId}:${row.validatedAt?.getTime()}`,
      }).onConflictDoNothing();
      return { kind: "updated" as const, row };
    }),
    }));
    if (result.kind === "not_found") return res.status(404).json({ message: "Evidence not found" });
    if (result.kind === "lifecycle-blocked") return res.status(409).json({ message: result.message });
    if (result.kind === "not_reviewable") return res.status(409).json({ message: "Evidence is not awaiting manual review." });
    if (result.kind === "stale") return res.status(409).json({ message: "Only the latest upload for this document can be used for this decision." });
    if (result.kind === "malware_blocked") return res.status(409).json({ message: "Approval is locked until the latest upload passes its security scan." });
    await reconcileDocumentationReadiness(organizationId, caseId);
    return res.json({
      id: result.row.id,
      validationState: result.row.validationState,
      validationReasons: hasOpaqueNarrativeAccess(sensitiveAccess)
        ? result.row.validationReasons
        : [{ code: "restricted", message: "Validation details are restricted to the assigned confidential-record reviewers." }],
      validatedAt: result.row.validatedAt,
    });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      return res.status(403).json({
        message: "Current document-edit, document-review, readiness-edit, document-tool and applicable sensitive-field grants are required to decide this document.",
        code: "DOCUMENT_ACCESS_REQUIRED",
      });
    }
    return next(error);
  }
});

router.post("/onboarding/cases/:id/evidence/:evidenceId/retry-malware-scan", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const caseId = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!Number.isInteger(caseId) || !Number.isInteger(evidenceId)) {
      return res.status(400).json({ message: "Valid case and evidence ids are required." });
    }
    const organizationId = getOrganizationId(req);
    const [owned] = await db.select({ id: onbCases.id }).from(onbCases).where(and(
      eq(onbCases.id, caseId),
      organizationWhere(onbCases, organizationId),
    ));
    if (!owned) return res.status(404).json({ message: "Case not found" });
    const [upload] = await db.select().from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.id, evidenceId),
      eq(onbCandidateUploads.caseId, caseId),
      eq(onbCandidateUploads.organizationId, organizationId),
    ));
    if (!upload) return res.status(404).json({ message: "Evidence not found" });
    const [document] = await db.select({
      key: onbDocuments.key,
      label: onbDocuments.label,
      category: onbDocuments.category,
    }).from(onbDocuments).where(and(
      eq(onbDocuments.id, upload.documentId),
      eq(onbDocuments.organizationId, organizationId),
      eq(onbDocuments.caseId, caseId),
    ));
    if (!document) return res.status(404).json({ message: "Document not found" });
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId,
      caseId,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, sensitiveClassForDocument(document), "edit")) {
      return res.status(403).json({
        message: "Current document-tool, flow and applicable sensitive-field edit permissions are required to requeue this scan.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
    }
    const [latest] = await db.select({ id: onbCandidateUploads.id }).from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.documentId, upload.documentId),
      eq(onbCandidateUploads.caseId, caseId),
      eq(onbCandidateUploads.organizationId, organizationId),
    )).orderBy(desc(onbCandidateUploads.id)).limit(1);
    if (!latest || latest.id !== evidenceId) {
      return res.status(409).json({ message: "Only the latest upload for this document can be rescanned." });
    }
    if (!malwareScanCanRetry(upload.malwareScanState)) {
      return res.status(409).json({ message: "This security scan cannot be retried in its current state." });
    }
    const classes = sensitiveClassForDocument(document);
    const requeued = await withSensitiveAuthorityFence({
      organizationId,
      caseId,
      actorUserId: req.authUserId!,
      classification: classes[0]!,
      additionalClassifications: classes.slice(1),
      additionalAccessKeys: [
        "tool.documents.edit",
        "data.documents.edit",
        "flow.document-review.edit",
        "data.case.readiness.edit",
      ],
      mutate: () => requeueDocumentMalwareScan(organizationId, caseId, evidenceId),
    });
    if (!requeued) return res.status(409).json({ message: "This security scan could not be queued again." });
    return res.json({ id: evidenceId, malwareScanState: "pending", malwareScannedAt: null, canRetryScan: false });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      return res.status(403).json({
        message: "Current document-edit, document-review, readiness-edit, document-tool and applicable sensitive-field grants are required to requeue this scan.",
        code: "DOCUMENT_ACCESS_REQUIRED",
      });
    }
    return next(error);
  }
});

router.get("/onboarding/cases/:id/bgv", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const [owned] = await db.select({ id: onbCases.id }).from(onbCases).where(and(eq(onbCases.id, caseId), organizationWhere(onbCases, getOrganizationId(req))));
    if (!owned) return res.status(404).json({ message: "Case not found" });
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId,
      actorUserId: req.authUserId,
    });
    const rows = await db.select({
      id: onbSystemChecks.id, system: onbSystemChecks.system, externalRef: onbSystemChecks.externalRef,
      status: onbSystemChecks.status, requestedAt: onbSystemChecks.requestedAt, dueAt: onbSystemChecks.dueAt,
      completedAt: onbSystemChecks.completedAt, note: onbSystemChecks.note,
    }).from(onbSystemChecks).where(and(eq(onbSystemChecks.caseId, caseId), eq(onbSystemChecks.organizationId, getOrganizationId(req)), eq(onbSystemChecks.system, "bgv")));
    const canReadNarratives = hasOpaqueNarrativeAccess(sensitiveAccess);
    return res.json(rows.map((row) => hasSensitiveAccess(sensitiveAccess, ["bgv"])
      ? {
          id: row.id,
          system: row.system,
          status: normalizeBgvStatus(row.status),
          requestedAt: row.requestedAt,
          dueAt: row.dueAt,
          completedAt: row.completedAt,
          ...(canReadNarratives
            ? { externalRef: row.externalRef, note: row.note }
            : {
                externalRef: undefined,
                note: "Background-verification narrative details are restricted to the assigned confidential-record reviewers.",
                restrictedNarratives: true,
              }),
        }
      : {
          id: row.id,
          system: "bgv",
          status: normalizeBgvStatus(row.status),
          restricted: true,
          note: "Background-verification details are restricted to the assigned HR/compliance specialist.",
        }));
  } catch (error) { return next(error); }
});

router.get("/onboarding/cases/:id/records", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [c] = await db
      .select({ id: onbCases.id, workerEmail: onbCases.workerEmail })
      .from(onbCases)
      .where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!c) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const sensitiveAccess = await resolveSensitiveAccess({
      organizationId: getOrganizationId(req),
      caseId: id,
      actorUserId: req.authUserId,
    });
    if (!hasSensitiveAccess(sensitiveAccess, ["identity"])) {
      res.status(403).json({
        message: "Archived employment records are restricted to an assigned HR/compliance specialist.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    const stints = await getArchivedStints(c.workerEmail, getOrganizationId(req));
    const canReadNarratives = hasOpaqueNarrativeAccess(sensitiveAccess);
    res.json(
      stints.map((s) => ({
        id: s.id,
        workerEmail: s.workerEmail,
        workerName: s.workerName,
        role: s.role,
        department: s.department,
        startDate: s.startDate,
        endDate: s.endDate,
        exitReason: canReadNarratives
          ? s.exitReason
          : "Restricted confidential archived-record narrative.",
        noticeRequiredDays: s.noticeRequiredDays,
        noticeServedDays: s.noticeServedDays,
        performanceRating: s.performanceRating,
        rehireEligible: s.rehireEligible,
        notes: canReadNarratives
          ? s.notes
          : "Restricted confidential archived-record narrative.",
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases/:id/inbound", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = ReceiveOnboardingInboundBody.parse(req.body);
    if (body.channel !== "email" && body.channel !== "whatsapp") {
      res.status(400).json({ message: "channel must be 'email' or 'whatsapp'" });
      return;
    }
    const organizationId = getOrganizationId(req);
    if (!req.authUserId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!c) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const row = await withSensitiveAuthorityFence({
      organizationId,
      caseId: id,
      actorUserId: req.authUserId!,
      classification: "identity",
      mutate: async () => withSensitiveLifecycleFence(organizationId, async () => {
        // The privacy/lifecycle gate is intentionally inside the authority
        // fence too: a revoke or changed lifecycle policy cannot land between
        // this decision and candidate-attributed content persistence.
        const [currentCase] = await db.select().from(onbCases).where(and(
          eq(onbCases.id, id), eq(onbCases.organizationId, organizationId),
        ));
        if (!currentCase) throw new Error("Case not found");
        const lifecycle = await evaluateSensitiveLifecycleGate({
            organizationId,
            jurisdiction: jurisdictionForWorkforceContext(currentCase.workforceContext),
            dataClass: "candidate-contact",
            disclosure: false,
          });
        if (!lifecycle.allowed) throw new Error(`SENSITIVE_LIFECYCLE_BLOCKED:${lifecycle.reason}`);
        const from = body.channel === "whatsapp" && currentCase.workerPhone ? currentCase.workerPhone : currentCase.workerEmail;
        const [created] = await db.insert(onbCommunications).values({
          ...organizationValues(organizationId),
          caseId: id,
          channel: body.channel,
          direction: "inbound",
          toAddress: from,
          subject: null,
          body: body.body,
          status: "received",
          sensitive: true,
          sensitiveDataClass: "candidate-contact",
        }).returning();
        return created!;
      }),
    });
    handleInbound(id, body.channel as "email" | "whatsapp", body.body);
    res.status(201).json({
      id: row.id,
      caseId: row.caseId,
      channel: row.channel,
      direction: row.direction,
      status: row.status,
      sensitive: true,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "SENSITIVE_RECORD_ACCESS_REQUIRED") {
      res.status(403).json({ message: "A current HR/compliance authority assignment is required to record inbound candidate communications." });
      return;
    }
    if (err instanceof Error && err.message.startsWith("SENSITIVE_LIFECYCLE_BLOCKED:")) {
      res.status(409).json({ message: err.message.slice("SENSITIVE_LIFECYCLE_BLOCKED:".length) });
      return;
    }
    next(err);
  }
});

/* ------------------- Twilio WhatsApp inbound webhook ------------------ */

/**
 * Rejecting invalid X-Twilio-Signature headers keeps this public endpoint
 * from being used to inject fake "new hire" messages.
 */
function requestSignatureValid(req: Parameters<Parameters<IRouter["post"]>[1]>[0]): boolean {
  const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  return twilioSignatureValid({
    token: process.env.TWILIO_AUTH_TOKEN,
    signature: req.header("x-twilio-signature"),
    url: `${proto}://${host}${req.originalUrl}`,
    params: req.body as Record<string, string>,
  });
}

async function recordRejectedTwilioWebhook(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
): Promise<void> {
  await recordGuardrailEvent({
    organizationId: DEMO_ORGANIZATION_ID,
    key: "webhook-signature",
    action: "rejected",
    detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.`,
  });
}

async function recordAcceptedTwilioWebhook(input: {
  organizationId: string;
  action: string;
  caseId?: number | null;
  objectType: string;
  objectId?: string | number | null;
  outcome?: "success" | "failure";
  correctionOfId?: number | null;
}): Promise<void> {
  // Signature validation establishes the provider authority. Provider request
  // fields (phone, body, CallSid, MessageSid, tokens) are deliberately not
  // copied into audit metadata or object identifiers.
  await appendProtectedAudit({
    organizationId: input.organizationId,
    actorKind: "system",
    actorAuthority: "twilio:signed-webhook",
    action: input.action,
    outcome: input.outcome ?? "success",
    objectType: input.objectType,
    objectId: input.objectId == null ? null : String(input.objectId),
    caseReference: input.caseId == null ? null : `case:${input.caseId}`,
    source: "twilio-webhook",
    correctionOfId: input.correctionOfId ?? null,
  });
}

async function recordTwilioWebhookAttempt(input: Omit<Parameters<typeof recordAcceptedTwilioWebhook>[0], "outcome" | "correctionOfId">) {
  return appendProtectedAudit({
    organizationId: input.organizationId,
    actorKind: "system",
    actorAuthority: "twilio:signed-webhook",
    action: `${input.action}.attempted`,
    outcome: "attempted",
    objectType: input.objectType,
    objectId: input.objectId == null ? null : String(input.objectId),
    caseReference: input.caseId == null ? null : `case:${input.caseId}`,
    source: "twilio-webhook",
  });
}

const digitsOnly = (s: string) => s.replace(/\D/g, "");

router.post("/onboarding/webhooks/twilio/whatsapp", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN) {
      res.status(503).json({ message: "Twilio is not configured" });
      return;
    }
    if (!requestSignatureValid(req)) {
      await recordRejectedTwilioWebhook(req);
      res.status(403).json({ message: "Invalid Twilio signature" });
      return;
    }
    const from = String(req.body?.From ?? "").replace(/^whatsapp:/, "");
    const text = String(req.body?.Body ?? "").trim();
      const messageSid = String(req.body?.MessageSid ?? "");
    const respondEmpty = () => {
      res.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
    };
    if (!from || !text || !messageSid) {
      respondEmpty();
      return;
    }

    const cases = await db
      .select({
        id: onbCases.id,
        organizationId: onbCases.organizationId,
        workerPhone: onbCases.workerPhone,
      })
      .from(onbCases)
      .where(sql`${onbCases.lifecycleStage} not in ('complete')`)
      .orderBy(desc(onbCases.id));
    const fromDigits = digitsOnly(from);
    const matches = cases.filter(
      (c) => c.workerPhone && digitsOnly(c.workerPhone) === fromDigits,
    );
    if (matches.length === 1) {
      const match = matches[0];
      const auditAttempt = await recordTwilioWebhookAttempt({
        organizationId: match.organizationId,
        action: "onboarding.twilio.whatsapp-inbound",
        caseId: match.id,
        objectType: "case",
        objectId: match.id,
      });
      await recordInbound({
        caseId: match.id,
        organizationId: match.organizationId,
        channel: "whatsapp",
        fromAddress: from,
        subject: null,
        body: text.slice(0, 4000),
        externalMessageId: messageSid,
      });
      await recordAcceptedTwilioWebhook({
        organizationId: match.organizationId,
        action: "onboarding.twilio.whatsapp-inbound.accepted",
        caseId: match.id,
        objectType: "case",
        objectId: match.id,
        correctionOfId: auditAttempt.id,
      });
    }
    respondEmpty();
  } catch (err) {
    next(err);
  }
});

/* --------------------- Twilio Voice (AI phone calls) ------------------ */

/**
 * Start an outbound AI voice call for a case (day-before check-in or SLA
 * escalation), or run a simulated call through the identical conversation
 * engine when no verified phone is available.
 */
router.post("/onboarding/cases/:id/voice-call", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const id = Number(req.params.id);
    const [exists] = await db.select({ id: onbCases.id }).from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!exists) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const scenario = req.body?.scenario === "sla-escalation" ? "sla-escalation" : "day-before";
    if (req.body?.simulate === true) {
      const sim = await simulateVoiceCall(id, scenario);
      res.json({
        status: "simulated",
        note: `Simulated call complete — ${sim.transcript.length} turns, decisions: ${
          sim.decisions.length ? sim.decisions.map((d) => d.decision).join(", ") : "none"
        }. Transcript is on the case timeline.`,
      });
      return;
    }
    const result = await startVoiceCall({ caseId: id, scenario });
    res.json({ status: result.status, note: result.note });
  } catch (err) {
    next(err);
  }
});

/** Twilio fetches this when the hire answers: greet + listen. */
router.post("/onboarding/webhooks/twilio/voice-answer", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN || !requestSignatureValid(req)) {
      await recordRejectedTwilioWebhook(req);
      res.status(403).json({ message: "Invalid Twilio signature" });
      return;
    }
    const session = await getVoiceSession(String(req.query.token ?? ""), String(req.body?.CallSid ?? "") || undefined);
    if (!session) {
      res.type("text/xml").send(hangupTwiml("Sorry, this call session has expired. Goodbye."));
      return;
    }
    const greeting = session.turns[0]?.text ?? "Hello from the onboarding team.";
    if (session.runId) {
      res.type("text/xml").send(hangupTwiml("This demonstration has been retired. Goodbye."));
      return;
    }
    if (session.organizationId) {
      const auditAttempt = await recordTwilioWebhookAttempt({
        organizationId: session.organizationId,
        action: "onboarding.twilio.voice-answer",
        caseId: session.caseId,
        objectType: "voice-session",
      });
      await recordAcceptedTwilioWebhook({
        organizationId: session.organizationId,
        action: "onboarding.twilio.voice-answer.accepted",
        caseId: session.caseId,
        objectType: "voice-session",
        correctionOfId: auditAttempt.id,
      });
    }
    res.type("text/xml").send(gatherTwiml(greeting, session.token));
  } catch (err) {
    next(err);
  }
});

/** Each spoken reply from the hire lands here as a speech transcription. */
router.post("/onboarding/webhooks/twilio/voice-turn", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN || !requestSignatureValid(req)) {
      await recordRejectedTwilioWebhook(req);
      res.status(403).json({ message: "Invalid Twilio signature" });
      return;
    }
    const session = await getVoiceSession(String(req.query.token ?? ""), String(req.body?.CallSid ?? "") || undefined);
    if (!session) {
      res.type("text/xml").send(hangupTwiml("Sorry, this call session has expired. Goodbye."));
      return;
    }
    const speech = String(req.body?.SpeechResult ?? "").trim();
    if (!speech) {
      res.type("text/xml").send(gatherTwiml("Sorry, I didn't catch that — could you say it again?", session.token));
      return;
    }
    const auditAttempt = session.organizationId
      ? await recordTwilioWebhookAttempt({
          organizationId: session.organizationId,
          action: "onboarding.twilio.voice-turn",
          caseId: session.caseId,
          objectType: "voice-session",
        })
      : null;
    if (session.runId) {
      res.type("text/xml").send(hangupTwiml("This demonstration has been retired. Goodbye."));
      return;
    }
    const { say, done } = await voiceTurn(session, speech);
    if (session.organizationId) {
      await recordAcceptedTwilioWebhook({
        organizationId: session.organizationId,
        action: "onboarding.twilio.voice-turn.accepted",
        caseId: session.caseId,
        objectType: "voice-session",
        correctionOfId: auditAttempt?.id,
      });
    }
    if (done) {
      // For a demo call the provider's signed status callback is the source
      // of truth for completion.  An accepted/connected call is not silently
      // promoted to delivered/completed by the script response.
      if (!session.runId) await finalizeVoiceCall(session, "completed");
      res.type("text/xml").send(hangupTwiml(say));
    } else {
      res.type("text/xml").send(gatherTwiml(say, session.token));
    }
  } catch (err) {
    next(err);
  }
});

/** Call ended (hangup/no-answer/failed): make sure the transcript lands. */
router.post("/onboarding/webhooks/twilio/voice-status", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN || !requestSignatureValid(req)) {
      await recordRejectedTwilioWebhook(req);
      res.status(403).json({ message: "Invalid Twilio signature" });
      return;
    }
    const session = await getVoiceSession(String(req.query.token ?? ""), String(req.body?.CallSid ?? "") || undefined);
    const callStatus = String(req.body?.CallStatus ?? "").trim().toLowerCase();
    const terminalStatuses = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
    if (session && !session.finalized && callStatus) {
      const auditAttempt = session.organizationId
        ? await recordTwilioWebhookAttempt({
            organizationId: session.organizationId,
            action: "onboarding.twilio.voice-status",
            caseId: session.caseId,
            objectType: "voice-session",
          })
        : null;
      await db.update(onbVoiceSessions).set({
        providerStatus: callStatus,
      }).where(and(
        eq(onbVoiceSessions.token, session.token),
        eq(onbVoiceSessions.organizationId, session.organizationId ?? ""),
        eq(onbVoiceSessions.finalized, false),
      ));
      session.providerStatus = callStatus;
      if (terminalStatuses.has(callStatus)) {
        await finalizeVoiceCall(session, callStatus);
      } else {
        // queued/ringing/in-progress/accepted are provider observations, not
        // delivery or completion. Persist them while leaving the session
        // live for the terminal signed callback.
      }
      if (session.organizationId) {
        await recordAcceptedTwilioWebhook({
          organizationId: session.organizationId,
          action: "onboarding.twilio.voice-status.accepted",
          caseId: session.caseId,
          objectType: "voice-session",
          correctionOfId: auditAttempt?.id,
        });
      }
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Twilio MessageStatus callback for outbound WhatsApp sends. Twilio POSTs
 * here (via the StatusCallback param set when sending) as the message moves
 * queued → sent → delivered/failed, so the communication row reflects
 * actual delivery, not just API acceptance.
 */
router.post(
  "/onboarding/webhooks/twilio/whatsapp-status",
  async (req, res, next) => {
    try {
      if (!process.env.TWILIO_AUTH_TOKEN) {
        res.status(503).json({ message: "Twilio is not configured" });
        return;
      }
      if (!requestSignatureValid(req)) {
        await recordRejectedTwilioWebhook(req);
        res.status(403).json({ message: "Invalid Twilio signature" });
        return;
      }
      const messageSid = String(req.body?.MessageSid ?? "");
      const messageStatus = String(req.body?.MessageStatus ?? "").toLowerCase();
      if (!messageSid || !messageStatus) {
        res.status(400).json({ message: "MessageSid and MessageStatus are required" });
        return;
      }
      // Only final states change the row; intermediate ones (queued, sent)
      // would just churn it. "read" implies delivered.
      const finalStatus =
        messageStatus === "delivered" || messageStatus === "read"
          ? "delivered"
          : messageStatus === "failed" || messageStatus === "undelivered"
            ? "failed"
            : null;
      if (!finalStatus) {
        res.status(204).end();
        return;
      }
      const errorCode = String(req.body?.ErrorCode ?? "").trim();
      const errorMessage = String(req.body?.ErrorMessage ?? "").trim();
      const failureReason =
        finalStatus === "failed"
          ? [`Twilio reported ${messageStatus}`, errorCode && `error ${errorCode}`, errorMessage]
              .filter(Boolean)
              .join(" — ")
              .slice(0, 300)
          : null;

      const candidates = await db
        .select({ id: onbCommunications.id, organizationId: onbCommunications.organizationId })
        .from(onbCommunications)
        .where(and(
          eq(onbCommunications.externalMessageId, messageSid),
          eq(onbCommunications.direction, "outbound"),
          eq(onbCommunications.channel, "whatsapp"),
        ));
      if (candidates.length === 1) {
        const candidate = candidates[0];
        const auditAttempt = await recordTwilioWebhookAttempt({
          organizationId: candidate.organizationId,
          action: "onboarding.twilio.whatsapp-status",
          objectType: "communication",
          objectId: candidate.id,
        });
        await db
          .update(onbCommunications)
          .set({ status: finalStatus, failureReason })
          .where(and(
            eq(onbCommunications.id, candidate.id),
            organizationWhere(onbCommunications, candidate.organizationId),
          ));
        await recordAcceptedTwilioWebhook({
          organizationId: candidate.organizationId,
          action: "onboarding.twilio.whatsapp-status.accepted",
          objectType: "communication",
          objectId: candidate.id,
          outcome: finalStatus === "delivered" ? "success" : "failure",
          correctionOfId: auditAttempt.id,
        });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ----------------------------- approvals ----------------------------- */

function authorityAssignmentResponse(row: typeof onbAuthorityAssignments.$inferSelect) {
  return {
    id: row.id,
    personUserId: row.personUserId,
    personEmail: row.personEmail,
    emailResponderAuthorized: row.emailResponderAuthorized,
    authorityRole: row.authorityRole,
    scopes: row.scopes,
    caseId: row.caseId,
    siteScope: row.siteScope,
    jurisdictionScope: row.jurisdictionScope,
    validFrom: row.validFrom.toISOString(),
    validUntil: iso(row.validUntil),
    status: row.status,
    revision: row.revision,
    grantorUserId: row.grantorUserId,
    source: row.source,
    governanceDecisionRef: row.governanceDecisionRef,
    revokedByUserId: row.revokedByUserId,
    revokedAt: iso(row.revokedAt),
    revokeReason: row.revokeReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function authorityBody(value: unknown): {
  personUserId: string; personEmail: string | null; emailResponderAuthorized: boolean;
  authorityRole: (typeof AUTHORITY_ROLES)[number]; scopes: (typeof AUTHORITY_SCOPES)[number][];
  caseId: number | null; siteScope: string | null; jurisdictionScope: string | null;
  validFrom: Date; validUntil: Date | null; governanceDecisionRef: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const text = (key: string, required = false): string | null => {
    const input = body[key];
    if (input === undefined || input === null) return required ? null : null;
    return typeof input === "string" && input.trim().length <= 250 ? input.trim() : null;
  };
  const personUserId = text("personUserId", true);
  const authorityRole = text("authorityRole", true);
  const decisionRef = text("governanceDecisionRef", true);
  const scopes = body.scopes;
  if (!personUserId || !authorityRole || !decisionRef || !Array.isArray(scopes) ||
      !scopes.length || !scopes.every((scope) => typeof scope === "string" && AUTHORITY_SCOPES.includes(scope as never)) ||
      !AUTHORITY_ROLES.includes(authorityRole as never) ||
      !scopes.every((scope) => roleMayExerciseScope(
        authorityRole as (typeof AUTHORITY_ROLES)[number],
        scope as (typeof AUTHORITY_SCOPES)[number],
      ))) return null;
  const validFrom = body.validFrom === undefined ? new Date() : new Date(String(body.validFrom));
  const validUntil = body.validUntil == null ? null : new Date(String(body.validUntil));
  const caseId = body.caseId == null ? null : Number(body.caseId);
  const personEmail = text("personEmail");
  const emailResponderAuthorized = body.emailResponderAuthorized === true;
  if (!Number.isFinite(validFrom.getTime()) ||
      (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom)) ||
      (caseId !== null && (!Number.isSafeInteger(caseId) || caseId < 1)) ||
       (personEmail !== null && (!isValidEmail(personEmail) || personEmail.length > 250)) ||
       (emailResponderAuthorized && personEmail === null)) return null;
  return {
    personUserId,
    personEmail,
    emailResponderAuthorized,
    authorityRole: authorityRole as (typeof AUTHORITY_ROLES)[number],
    scopes: [...new Set(scopes)] as (typeof AUTHORITY_SCOPES)[number][],
    caseId,
    siteScope: text("siteScope"),
    jurisdictionScope: text("jurisdictionScope"),
    validFrom,
    validUntil,
    governanceDecisionRef: decisionRef,
  };
}

async function clerkVerifiedEmailForUser(personUserId: string, email: string): Promise<boolean> {
  const user = await clerkClient.users.getUser(personUserId);
  const normalized = email.trim().toLowerCase();
  return user.emailAddresses.some((address) =>
    address.emailAddress.trim().toLowerCase() === normalized &&
    address.verification?.status === "verified",
  );
}

router.get("/onboarding/authority/governance", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const [governance] = await db.select().from(onbAuthorityGovernance).where(
      eq(onbAuthorityGovernance.organizationId, organizationId),
    );
    const mine = await db.select().from(onbAuthorityAssignments).where(and(
      eq(onbAuthorityAssignments.organizationId, organizationId),
      eq(onbAuthorityAssignments.personUserId, req.authUserId!),
    ));
    const canAdminister = await db.transaction((tx) =>
      canAdministerAuthority(tx, organizationId, req.authUserId!),
    );
    res.json({
      governance: governance ? {
        status: governance.status,
        attestedAt: iso(governance.attestedAt),
        attestationNote: governance.attestationNote,
        approvedAt: iso(governance.approvedAt),
        governanceSource: governance.governanceSource,
        revision: governance.revision,
      } : { status: "unconfigured", revision: 0 },
      canAdminister,
      assignments: mine.map(authorityAssignmentResponse),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/authority/bootstrap", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Only an organization owner or admin may record an operator governance attestation.")) return;
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    if (!note) {
      res.status(400).json({ message: "An operator attestation note is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const governance = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(onbAuthorityGovernance).where(
        eq(onbAuthorityGovernance.organizationId, organizationId),
      ).for("update");
      if (existing?.status === "governance-approved") {
        return existing;
      }
      const [updated] = await tx.insert(onbAuthorityGovernance).values({
        organizationId,
        status: "operator-attested",
        operatorUserId: req.authUserId!,
        attestedAt: new Date(),
        attestationNote: note,
        revision: (existing?.revision ?? 0) + 1,
      }).onConflictDoUpdate({
        target: onbAuthorityGovernance.organizationId,
        set: {
          status: "operator-attested",
          operatorUserId: req.authUserId!,
          attestedAt: new Date(),
          attestationNote: note,
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: new Date(),
        },
      }).returning();
      await auditAuthority(tx, organizationId, req.authUserId!, "operator-attested", {
        label: "Operator attestation only; this is not directory verification and cannot authorize production specialist decisions.",
      });
      return updated;
    });
    res.status(201).json({
      status: governance.status,
      message: "Operator attestation recorded. Production specialist authority remains disabled until an approved governance decision is recorded outside this self-service workflow.",
    });
  } catch (err) {
    next(err);
  }
});

/** Immediate tenant-wide kill switch for specialist authority. */
router.post("/onboarding/authority/governance/withdraw", async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!reason) {
      res.status(400).json({ message: "A governance withdrawal reason is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const updated = await db.transaction(async (tx) => {
      // Verify the administrator while governance remains live and while the
      // shared dispatch/revocation fence is held.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      if (!(await canAdministerAuthority(tx, organizationId, req.authUserId!))) return null;
      const [row] = await tx.update(onbAuthorityGovernance).set({
        status: "withdrawn", revision: sql`${onbAuthorityGovernance.revision} + 1`, updatedAt: new Date(),
      }).where(eq(onbAuthorityGovernance.organizationId, organizationId)).returning();
      if (row) await auditAuthority(tx, organizationId, req.authUserId!, "governance-withdrawn", { reason });
      return row;
    });
    if (!updated) {
      res.status(403).json({ message: "A current governance-approved authority administrator is required." });
      return;
    }
    res.json({ status: updated.status, message: "Governance authority was withdrawn; all specialist decisions now fail closed." });
  } catch (err) { next(err); }
});

/** Append-only configuration for cases where occupational safety controls are
 * mandatory. Profile labels and normal settings cannot alter this policy. */
router.get("/onboarding/authority/nonwaivable-safety-policy", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const permitted = await db.transaction((tx) => hasHumanPermissions(tx, {
      organizationId, actorUserId: req.authUserId!, requiredKeys: ["tool.policy.manage"],
    }));
    if (!permitted) {
      res.status(403).json({ message: "Current tenant-scoped policy-management permission is required." });
      return;
    }
    const value = await getSetting(organizationId, NONWAIVABLE_SAFETY_POLICY_KEY);
    let itemIds: string[] = [];
    try { itemIds = Array.isArray(JSON.parse(value ?? "[]")) ? JSON.parse(value ?? "[]") : []; } catch { itemIds = []; }
    res.json({ itemIds });
  } catch (err) { next(err); }
});

router.post("/onboarding/authority/nonwaivable-safety-policy", async (req, res, next) => {
  try {
    const values = Array.isArray(req.body?.itemIds) ? req.body.itemIds : null;
    if (!values || !values.every((id: unknown) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) {
      res.status(400).json({ message: "itemIds must be stable lowercase checklist identifiers." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      if (!(await hasHumanPermissions(tx, {
        organizationId, actorUserId: req.authUserId!, requiredKeys: ["tool.policy.manage"],
      }))) return null;
      const [existing] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, NONWAIVABLE_SAFETY_POLICY_KEY),
      )).for("update");
      let old: string[] = [];
      try { old = Array.isArray(JSON.parse(existing?.value ?? "[]")) ? JSON.parse(existing?.value ?? "[]") : []; } catch { old = []; }
      const next = [...new Set(values)].sort();
      if (old.some((id) => !next.includes(id))) throw new Error("Nonwaivable safety identifiers are immutable and may not be removed.");
      await tx.insert(onbSettings).values({
        organizationId, key: NONWAIVABLE_SAFETY_POLICY_KEY, value: JSON.stringify(next),
      }).onConflictDoUpdate({
        target: [onbSettings.organizationId, onbSettings.key],
        set: { value: JSON.stringify(next), updatedAt: new Date() },
      });
      // Materialize the policy into a new immutable effective-template
      // version so all subsequently created cases carry the protected bit.
      const base = await getEffectiveChecklist(organizationId, tx);
      {
        const items = base.items.map((item) => ({
          ...item,
          nonWaivableSafety: item.nonWaivableSafety === true || next.includes(item.id),
          enabled: item.nonWaivableSafety === true || next.includes(item.id) ? true : item.enabled,
          mandatory: item.nonWaivableSafety === true || next.includes(item.id) ? true : item.mandatory,
        }));
        await tx.insert(onbChecklistTemplates).values({
          organizationId, version: base.version + 1, items, createdBy: req.authUserId!,
        });
      }
      await auditAuthority(tx, organizationId, req.authUserId!, "nonwaivable-safety-policy-updated", { itemIds: next });
      return next;
    });
    if (!saved) {
      res.status(403).json({ message: "Current tenant-scoped policy-management permission is required." });
      return;
    }
    res.json({ itemIds: saved, message: "Protected safety identifiers are append-only. Existing case snapshots remain immutable." });
  } catch (err) { next(err); }
});

router.get("/onboarding/authority/assignments", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const permitted = await db.transaction((tx) => canAdministerAuthority(tx, organizationId, req.authUserId!));
    if (!permitted) {
      res.status(403).json({ message: "A current governance-approved authority-administration assignment is required." });
      return;
    }
    const rows = await db.select().from(onbAuthorityAssignments).where(
      eq(onbAuthorityAssignments.organizationId, organizationId),
    );
    res.json(rows.map(authorityAssignmentResponse));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/authority/assignments", async (req, res, next) => {
  try {
    const body = authorityBody(req.body);
    if (!body) {
      res.status(400).json({ message: "Invalid authority assignment. A tenant member, approved role/scopes, bounded dates, and governance decision reference are required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    if (await registeredDemoProfile(body.personUserId)) {
      res.status(403).json({
        message: "Shared demo accounts cannot receive governance-managed authority assignments.",
        code: "DEMO_ACCOUNT_PRIVILEGE_CEILING",
      });
      return;
    }
    if (body.personUserId === req.authUserId) {
      res.status(403).json({ message: "Self-grant of specialist authority is prohibited." });
      return;
    }
    // Email authority is an explicit governance-admin grant to an exact
    // address of the assignment's actual Clerk member. It cannot be enabled
    // from a contact label, shared persona, or claimed mailbox string.
    if (body.emailResponderAuthorized) {
      try {
        if (!body.personEmail || !(await clerkVerifiedEmailForUser(body.personUserId, body.personEmail))) {
          res.status(400).json({ message: "Email decisions require an exact Clerk-verified email address belonging to the selected member." });
          return;
        }
      } catch {
        res.status(503).json({ message: "Clerk verification is unavailable; email decision authority was not granted." });
        return;
      }
    }
    const assignment = await db.transaction(async (tx) => {
      // This is the same tenant fence used by revocation and final connector
      // dispatch. Authority cannot be withdrawn between authorization and grant.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      if (!(await canAdministerAuthority(tx, organizationId, req.authUserId!))) return null;
      const [member] = await tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, body.personUserId),
        isNull(organizationMembershipsTable.revokedAt),
      ));
      if (!member) throw new Error("Authority subject is not a member of this organization.");
      if (body.caseId !== null) {
        const [c] = await tx.select({ id: onbCases.id }).from(onbCases).where(and(
          eq(onbCases.organizationId, organizationId), eq(onbCases.id, body.caseId),
        ));
        if (!c) throw new Error("Case scope does not belong to this organization.");
      }
      const [created] = await tx.insert(onbAuthorityAssignments).values({
        id: newAuthorityId(), organizationId, ...body, status: "active",
        revision: 1, grantorUserId: req.authUserId!,
        source: body.emailResponderAuthorized ? "governance-decision:clerk-verified-email" : "governance-decision",
      }).returning();
      await auditAuthority(tx, organizationId, req.authUserId!, "granted", {
        personUserId: body.personUserId, authorityRole: body.authorityRole,
        scopes: body.scopes, governanceDecisionRef: body.governanceDecisionRef,
        emailResponderAuthorized: body.emailResponderAuthorized,
      }, created.id);
      return created;
    });
    if (!assignment) {
      res.status(403).json({ message: "A current governance-approved authority-administration assignment is required." });
      return;
    }
    res.status(201).json(authorityAssignmentResponse(assignment));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/authority/assignments/:id/revoke", async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!reason) {
      res.status(400).json({ message: "A revocation reason is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const assignment = await db.transaction(async (tx) => {
      // Paired with the connector final-dispatch fence. Do not let a
      // revocation commit between its live authority check and provider write.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      if (!(await canAdministerAuthority(tx, organizationId, req.authUserId!))) return null;
      const [updated] = await tx.update(onbAuthorityAssignments).set({
        status: "revoked", revision: sql`${onbAuthorityAssignments.revision} + 1`,
        revokedAt: new Date(), revokedByUserId: req.authUserId!, revokeReason: reason, updatedAt: new Date(),
      }).where(and(
        eq(onbAuthorityAssignments.organizationId, organizationId),
        eq(onbAuthorityAssignments.id, req.params.id),
        eq(onbAuthorityAssignments.status, "active"),
      )).returning();
      if (updated) await auditAuthority(tx, organizationId, req.authUserId!, "revoked", { reason }, updated.id);
      return updated;
    });
    if (!assignment) {
      res.status(404).json({ message: "Authority assignment not found or not currently revocable." });
      return;
    }
    res.json(authorityAssignmentResponse(assignment));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/authority/unresolved-approvals", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Only organization owners and admins may review unresolved historical authority evidence.")) return;
    const organizationId = getOrganizationId(req);
    const rows = await db.select().from(onbApprovals).where(and(
      eq(onbApprovals.organizationId, organizationId),
      or(
        eq(onbApprovals.authorityReviewStatus, "unresolved"),
        and(
          isNull(onbApprovals.authorityScope),
          ne(onbApprovals.authorityReviewStatus, "reviewed-no-effect"),
        ),
      ),
    ));
    res.json(rows.map((row) => ({
      id: row.id, caseId: row.caseId, status: row.status, version: row.version,
      // Historical approval narrative is opaque private evidence. Tenant
      // administration permits remediation of the record, never disclosure
      // of its recommendation/rationale/comment to an owner or admin.
      recommendation: "Restricted historical approval evidence.",
      authorityScope: row.authorityScope,
      createdAt: row.createdAt.toISOString(), decidedAt: iso(row.decidedAt),
      restricted: true,
    })));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/authority/unresolved-approvals/:id/acknowledge", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Only organization owners and admins may acknowledge unresolved historical authority evidence.")) return;
    const organizationId = getOrganizationId(req);
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [current] = await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, Number(req.params.id)),
      )).for("update");
      if (!current || !(
        current.authorityReviewStatus === "unresolved" ||
        (current.authorityScope === null && current.authorityReviewStatus !== "reviewed-no-effect")
      )) return null;
      const [caseRow] = await tx.select({ id: onbCases.id, lifecycleStage: onbCases.lifecycleStage })
        .from(onbCases).where(and(eq(onbCases.id, current.caseId), eq(onbCases.organizationId, organizationId))).for("update");
      if (!caseRow) return null;
      if (current.status === "pending" && caseRow.lifecycleStage !== "complete") {
        await reopenApprovalInTransaction(tx, {
          organizationId, caseId: current.caseId, approvalId: current.id,
          reopenStatuses: ["pending"], authorityScope: authorityScopeForApproval(current),
          reason: "Historical pending authority evidence acknowledged; renewed as a scoped review cycle.",
          actor: req.authUserId!,
        });
      }
      const [row] = await tx.update(onbApprovals).set({
        authorityReviewStatus: "reviewed-no-effect",
        authorityReviewedByUserId: req.authUserId!,
        authorityReviewedAt: new Date(),
      }).where(and(eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, current.id))).returning();
      return row;
    });
    if (!updated) {
      res.status(404).json({ message: "Unresolved historical approval not found." });
      return;
    }
    await db.transaction((tx) => auditAuthority(tx, organizationId, req.authUserId!, "legacy-approval-reviewed-no-effect", {
      approvalId: updated.id, version: updated.version,
    }));
    res.json({ id: updated.id, reviewStatus: updated.authorityReviewStatus, message: updated.status === "pending"
      ? "Historical evidence was archived and renewed in place as a scoped authority-bound review. No historical decision, continuation, or provider effect was replayed."
      : "Historical evidence was acknowledged only. No decision, authority, continuation, or provider effect was replayed." });
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/approvals", async (req, res, next) => {
  try {
    const wantAll = req.query.status === "all";
    const rows = await db
      .select({
        approval: onbApprovals,
        workerName: onbCases.workerName,
        notes: onbCases.notes,
        scenarioKey: onbCases.scenarioKey,
        syntheticProvenance: onbCases.syntheticProvenance,
        controllerRetired: onbCases.controllerRetired,
        candidateEmailAuthorizedAt: onbCases.candidateEmailAuthorizedAt,
        candidateEmailAuthorizedBy: onbCases.candidateEmailAuthorizedBy,
      })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(req)))
      .orderBy(desc(onbApprovals.createdAt), desc(onbApprovals.id));
    const demoProfile = await registeredDemoProfile(req.authUserId!);
    const rowsWithAccess = await Promise.all(rows.map(async (row) => ({
      ...row,
      historicalCase: isHistoricalTestRecord(row) || await isAuthoritativelyUatRunOwnedCase({
        organizationId: getOrganizationId(req), id: row.approval.caseId,
      }),
      caseAccess: await caseGovernanceAccessForRequest(req, {
        organizationId: getOrganizationId(req),
        id: row.approval.caseId,
      }),
    })));
    const visibleRows = rowsWithAccess.filter(({
      approval,
      notes,
      scenarioKey,
      syntheticProvenance,
      candidateEmailAuthorizedAt,
      candidateEmailAuthorizedBy,
      caseAccess,
      historicalCase,
    }) =>
      !historicalCase &&
      caseAccess.flowRead &&
      (!isDay1ReadinessApproval(approval) || caseAccess.readinessRead) &&
      (!demoProfile ||
        isSyntheticOfflineCase({ notes, scenarioKey, syntheticProvenance }) ||
        false));
    const filtered = wantAll
      ? visibleRows
      : visibleRows.filter((row) => row.approval.status === "pending");
    res.json(await Promise.all(filtered.map(async ({ approval: a, workerName }) => {
      const sensitiveAccess = await resolveSensitiveAccess({
        organizationId: getOrganizationId(req),
        caseId: a.caseId,
        actorUserId: req.authUserId,
      });
      const caseAccess = await caseGovernanceAccessForRequest(req, {
        organizationId: getOrganizationId(req),
        id: a.caseId,
      });
      const scopeClasses = a.authorityScope === "occupational-health-approve"
        ? ["medical"] as const
        : a.authorityScope === "payroll-approve"
          ? ["payroll"] as const
          : a.authorityScope === "hr-compliance-approve"
            ? ["identity", "bgv"] as const
            : [];
      // Approval recommendation, rationale, comment, and evidence are opaque
      // narratives. Scope metadata can restrict access further, but cannot
      // turn a partial specialist assignment into a grant for mixed text.
      const restricted = !caseAccess.notesRead || !caseAccess.profileRead ||
        !hasOpaqueNarrativeAccess(sensitiveAccess) ||
        !hasSensitiveAccess(sensitiveAccess, scopeClasses);
      if (restricted) {
        return {
          id: a.id,
          caseId: a.caseId,
          caseWorkerName: sensitiveAccess.identity && caseAccess.profileRead
            ? workerName
            : "Restricted candidate",
          agent: a.agent,
          ruleRef: "restricted-sensitive-approval",
          hitlPattern: a.hitlPattern,
          recommendation: "Restricted specialist approval pending or recorded.",
          rationale: "Details are restricted to the assigned specialist.",
          recordsEvidence: null,
          status: a.status,
          version: a.version,
          authorityScope: a.authorityScope,
          authorityReviewStatus: a.authorityReviewStatus,
          decidedAuthorityId: null,
          decidedBy: null,
          comment: null,
          createdAt: a.createdAt.toISOString(),
          decidedAt: iso(a.decidedAt),
          restricted: true,
        };
      }
      return {
        id: a.id,
        caseId: a.caseId,
        caseWorkerName: sensitiveAccess.identity ? workerName : "Restricted candidate",
        agent: a.agent,
        ruleRef: a.ruleRef,
        hitlPattern: a.hitlPattern,
        recommendation: a.recommendation,
        rationale: a.rationale,
        recordsEvidence: a.recordsEvidence,
        status: a.status,
        version: a.version,
        authorityScope: a.authorityScope,
        authorityReviewStatus: a.authorityReviewStatus,
        decidedAuthorityId: a.decidedAuthorityId,
        decidedBy: a.decidedBy,
        comment: a.comment,
        createdAt: a.createdAt.toISOString(),
        decidedAt: iso(a.decidedAt),
      };
    })));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/approvals/:id/history", async (req, res, next) => {
  try {
    const approvalId = Number(req.params.id);
    if (!Number.isSafeInteger(approvalId) || approvalId < 1) {
      res.status(400).json({ message: "A valid approval id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const [approval] = await db.select({
      id: onbApprovals.id,
      caseId: onbApprovals.caseId,
      authorityScope: onbApprovals.authorityScope,
      idempotencyKey: onbApprovals.idempotencyKey,
    }).from(onbApprovals)
      .where(and(eq(onbApprovals.id, approvalId), eq(onbApprovals.organizationId, organizationId)));
    if (!approval) {
      res.status(404).json({ message: "Approval not found" });
      return;
    }
    if (isDay1ReadinessApproval(approval)) {
      const readinessAccess = await resolveEffectiveAccess({
        organizationId,
        principalType: "human",
        principalId: req.authUserId!,
        caseId: approval.caseId,
        purpose: "onboarding-readiness-history-read",
      });
      if (!readinessAccess.allows.includes("data.case.readiness.read")) {
        res.status(403).json({
          message: "An explicit readiness-read grant is required to review Day-1 Readiness approval history.",
          code: "CASE_READINESS_ACCESS_REQUIRED",
        });
        return;
      }
    }
    const auditAccess = await resolveEffectiveAccess({
      organizationId,
      principalType: "human",
      principalId: req.authUserId!,
      caseId: approval.caseId,
      purpose: "onboarding-approval-history-read",
    });
    if (!auditAccess.allows.includes("data.audit.read")) {
      res.status(403).json({
        message: "An explicit audit-read grant is required to review approval history.",
        code: "AUDIT_ACCESS_REQUIRED",
      });
      return;
    }
    const authorityScope = approval.authorityScope;
    if (!authorityScope || !(await db.transaction((tx) => hasCurrentAuthorityScope(tx, {
      organizationId,
      actorUserId: req.authUserId!,
      scope: authorityScope,
      caseId: approval.caseId,
    })))) {
      res.status(403).json({
        message: "Approval-history detail is restricted to the currently assigned specialist.",
        code: "SENSITIVE_RECORD_ACCESS_REQUIRED",
      });
      return;
    }
    res.json(await getApprovalHistory({ organizationId, approvalId }));
  } catch (err) {
    next(err);
  }
});

/**
 * Read-only UI preflight. The mutation performs this same live check inside
 * its tenant fence; this endpoint merely prevents presenting an actionable
 * control based on a browser role, stale assignment, or display persona.
 */
router.get("/onboarding/approvals/:id/capability", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ message: "A valid approval id is required." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const [approval] = await db.select().from(onbApprovals).where(and(
      eq(onbApprovals.id, id),
      eq(onbApprovals.organizationId, organizationId),
    ));
    if (!approval) {
      res.status(404).json({ message: "Approval not found" });
      return;
    }
    if (approval.status !== "pending") {
      const review = await db.transaction(async tx => {
        const requiresFreshReview = approval.status === "approved" && !await decisionAuthorityStillCurrent(tx, approval);
        const [c] = await tx.select({ lifecycleStage: onbCases.lifecycleStage }).from(onbCases).where(and(
          eq(onbCases.organizationId, organizationId), eq(onbCases.id, approval.caseId),
        ));
        const canRequestFreshReview = requiresFreshReview && !!c && c.lifecycleStage !== "complete" &&
          await hasHumanPermissions(tx, { organizationId, actorUserId: req.authUserId!, caseId: approval.caseId,
            requiredKeys: ["flow.case.edit", "data.case.profile.edit"] });
        return { requiresFreshReview, canRequestFreshReview };
      });
      res.json({ canDecide: false, reason: review.requiresFreshReview ? "fresh_human_review_required" : "approval_not_pending", version: approval.version, ...review });
      return;
    }
    if (!Number.isSafeInteger(approval.version) || approval.version < 1) {
      res.json({ canDecide: false, reason: "invalid_approval_version", version: approval.version });
      return;
    }
    if (isDay1ReadinessApproval(approval)) {
      const readinessAccess = await resolveEffectiveAccess({
        organizationId,
        principalType: "human",
        principalId: req.authUserId!,
        caseId: approval.caseId,
        purpose: "onboarding-readiness-decision-capability",
      });
      if (!readinessAccess.allows.includes("data.case.readiness.edit")) {
        res.json({
          canDecide: false,
          reason: "readiness_access_required",
          version: approval.version,
        });
        return;
      }
    }
    const authority = await db.transaction((tx) => verifyDecisionAuthorityInTransaction(tx, {
      organizationId,
      approval,
      actorUserId: req.authUserId!,
    }));
    res.json({
      canDecide: authority.allowed,
      reason: authority.allowed ? null : authority.reason,
      version: approval.version,
      reviewOnly: approval.ruleRef === OFFER_ACCEPTANCE_GATE_RULE && approval.resumeAction === "none",
    });
  } catch (err) {
    next(err);
  }
});

/** Renew only the review cycle: never resume work or replay provider outcomes. */
router.post("/onboarding/approvals/:id/fresh-review", async (req, res, next) => {
  try {
    const id = Number(req.params.id), expectedVersion = req.body?.expectedVersion;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        !req.body || Object.keys(req.body).some(key => key !== "expectedVersion")) {
      res.status(400).json({ message: "A current integer approval version is required." }); return;
    }
    const organizationId = getOrganizationId(req);
    const result = await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [ownership] = await tx.select({ caseId: onbApprovals.caseId }).from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, id),
      ));
      if (!ownership) return { status: 404, message: "Approval not found." };
      const [c] = await tx.select().from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId), eq(onbCases.id, ownership.caseId),
      )).for("update");
      if (!c || c.lifecycleStage === "complete" || isHistoricalTestRecord(c) ||
          (await getUatCaseIsolation(c)).isolated)
        return { status: 409, message: "Completed or historical cases cannot renew operational approvals." };
      if (!await hasHumanPermissions(tx, { organizationId, actorUserId: req.authUserId!, caseId: c.id,
        requiredKeys: ["flow.case.edit", "data.case.profile.edit"] }))
        return { status: 403, message: "Current case-flow and profile edit permissions are required." };
      const [approval] = await tx.select().from(onbApprovals).where(and(
        eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, id),
      )).for("update");
      if (!approval || approval.version !== expectedVersion || approval.status !== "approved")
        return { status: 409, message: "The approval changed. Refresh before requesting review." };
      if (await decisionAuthorityStillCurrent(tx, approval))
        return { status: 409, message: "The existing current-version permission-based decision remains valid." };
      const [ambiguous] = await tx.select({ key: onbEffectJournal.logicalOperationKey }).from(onbEffectJournal).where(and(
        eq(onbEffectJournal.organizationId, organizationId), eq(onbEffectJournal.caseId, c.id),
        inArray(onbEffectJournal.status, ["dispatching", "unknown_effect_manual_repair"]),
      )).limit(1);
      if (ambiguous) return { status: 409, message: "An in-flight or ambiguous provider effect requires reconciliation before fresh review. Nothing was replayed." };
      const renewed = await reopenApprovalInTransaction(tx, {
        organizationId, caseId: c.id, approvalId: approval.id, reopenStatuses: ["approved"],
        actor: req.authUserId!, reason: "Fresh human review requested; historical specialist receipts cannot authorize new effects.",
      });
      if (approval.ruleRef === OFFER_ACCEPTANCE_GATE_RULE && c.offerAcceptanceComplete) {
        // Renew permission evidence only. The historical acceptance fact and
        // provider history remain intact, and this review has no continuation.
        await tx.update(onbApprovals).set({ resumeAction: "none" }).where(and(
          eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, approval.id),
          eq(onbApprovals.version, renewed.version), eq(onbApprovals.status, "pending"),
        ));
      }
      // A genuinely new request supplies provenance for this review cycle, not
      // a retrospective claim about the requester of the historical decision.
      if (!approval.requestedByUserId && !c.createdByUserId) {
        await tx.update(onbApprovals).set({ requestedByUserId: req.authUserId! }).where(and(
          eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.id, approval.id),
          eq(onbApprovals.version, renewed.version), eq(onbApprovals.status, "pending"),
        ));
      }
      return { status: 200, version: renewed.version, reviewRequired: true, released: false };
    }));
    res.status(result.status).json(result);
  } catch (error) { next(error); }
});

router.post("/onboarding/approvals/:id/decide", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = DecideOnboardingApprovalBody.parse(req.body);
    if (body.decision !== "approved" && body.decision !== "rejected") {
      res.status(400).json({ message: "decision must be 'approved' or 'rejected'" });
      return;
    }
    const [a] = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(and(
        eq(onbApprovals.id, id),
        organizationWhere(onbCases, getOrganizationId(req)),
      ))
      .then((rows) => rows.map((row) => row.approval));
    if (!a) {
      res.status(404).json({ message: "Approval not found" });
      return;
    }
      if (a.ruleRef === OFFER_ACCEPTANCE_GATE_RULE && a.resumeAction !== "none") {
        res.status(409).json({
          message: "Offer-Acceptance Package requires dedicated offer-acceptance confirmation; generic approval decisions cannot release this stage.",
          code: "dedicated_offer_acceptance_confirmation_required",
        });
        return;
      }
    const decidedBy = await resolveReviewerName(req.authUserId!);
    const result = await decideApproval({
      organizationId: getOrganizationId(req),
      approvalId: id,
      expectedVersion: body.expectedVersion,
      decision: body.decision,
      decidedBy,
      comment: body.comment ?? null,
      actorUserId: req.authUserId!,
      additionalAccessKeys: isDay1ReadinessApproval(a) ? ["data.case.readiness.edit"] : [],
      auditCorrelationId: req.header("x-request-id") ?? req.header("x-correlation-id") ?? null,
    });
    if (result.outcome === "not-found") {
      res.status(404).json({ message: "Approval not found" });
      return;
    }
    if (result.outcome === "stale") {
      res.status(409).json({
        message: "This approval was already decided or replaced. Refresh to review the current request.",
        currentVersion: result.currentVersion,
        reason: result.reason,
      });
      return;
    }
    if (result.outcome === "unauthorized") {
      res.status(403).json({
        message: result.reason === "readiness_access_required"
          ? "An explicit data.case.readiness.edit grant is required for this approval decision."
          : "Current client/case approval-decision, flow-edit and applicable field permissions and an independent named reviewer are required. Labels and personas grant no access.",
        code: result.reason === "readiness_access_required" ? "CASE_READINESS_ACCESS_REQUIRED" : result.reason,
      });
      return;
    }
    const updated = result.approval;
    const [c] = await db
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, a.caseId),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    res.json({
      id: updated.id,
      version: updated.version,
      caseId: updated.caseId,
      caseWorkerName: c?.workerName ?? "",
      agent: updated.agent,
      ruleRef: updated.ruleRef,
      hitlPattern: updated.hitlPattern,
      recommendation: updated.recommendation,
      rationale: updated.rationale,
      recordsEvidence: updated.recordsEvidence,
      authorityScope: updated.authorityScope,
      authorityReviewStatus: updated.authorityReviewStatus,
      decidedAuthorityId: updated.decidedAuthorityId,
      status: updated.status,
      decidedBy: updated.decidedBy,
      comment: updated.comment,
      createdAt: updated.createdAt.toISOString(),
      decidedAt: iso(updated.decidedAt),
    });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- connectors ---------------------------- */

router.get("/onboarding/connectors", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    await ensureConnectorsSeeded(organizationId);
    const rows = await db
      .select()
      .from(onbConnectors)
      .where(organizationWhere(onbConnectors, organizationId));
    res.json(rows.map((row) => ({ ...row, lastSyncAt: iso(row.lastSyncAt) })));
  } catch (err) {
    next(err);
  }
});

router.patch("/onboarding/connectors/:key", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    await ensureConnectorsSeeded(organizationId);
    const body = UpdateOnboardingConnectorBody.parse(req.body);
    if (req.params.key in ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS) {
      res.status(409).json({
        message: `${req.params.key.toUpperCase()} is activation-pending. Its registry requirement has no provider adapter or simulated completion; approved vendor, privacy, least-privilege, and authenticated source-confirmation evidence are required before connector activation.`,
        code: "CONNECTOR_ACTIVATION_REQUIREMENTS_PENDING",
        requirements: ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS[
          req.params.key as keyof typeof ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS
        ],
      });
      return;
    }
    const [row] = await db
      .select()
      .from(onbConnectors)
      .where(and(
        eq(onbConnectors.key, req.params.key),
        organizationWhere(onbConnectors, organizationId),
      ));
    if (!row) {
      res.status(404).json({ message: "Connector not found" });
      return;
    }
    if (body.vendor !== undefined && !row.availableVendors.includes(body.vendor)) {
      res.status(400).json({
        message: `Vendor "${body.vendor}" is not available for ${row.label}`,
      });
      return;
    }
    const [updated] = await db
      .update(onbConnectors)
      .set({
        vendor: body.vendor ?? row.vendor,
        status: body.status ?? row.status,
        trackingMode: body.trackingMode ?? row.trackingMode,
        // Selecting a simulated catalog label, or changing transport mode,
        // cannot retain an earlier server-verified provider configuration.
        configurationProvenance:
          (body.vendor !== undefined && body.vendor !== row.vendor) ||
            (body.trackingMode !== undefined && body.trackingMode !== row.trackingMode)
            ? "simulated"
            : row.configurationProvenance,
        lastSyncAt: new Date(),
      })
      .where(and(
        eq(onbConnectors.key, req.params.key),
        organizationWhere(onbConnectors, organizationId),
      ))
      .returning();
    if (body.trackingMode && body.trackingMode !== row.trackingMode) {
      const def = WATCHED_SYSTEMS.find((system) => system.connectorKey === req.params.key);
      if (def) {
        await db
          .update(onbSystemChecks)
          .set({ mode: body.trackingMode === "email" ? "email" : def.mode })
          .where(and(
            eq(onbSystemChecks.system, def.key),
            organizationWhere(onbSystemChecks, organizationId),
            sql`${onbSystemChecks.status} in ('pending', 'overdue')`,
          ));
      }
    }
    res.json({ ...updated, lastSyncAt: iso(updated.lastSyncAt) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- watcher tick (cron) ------------------------ */

// Production heartbeat. The published app runs on autoscale, so the
// in-process setInterval pollers pause whenever no request is in flight —
// off-hours, health checks and SLA escalations would silently stop. An
// external scheduler (Replit Scheduled Deployment, uptime pinger, cron)
// hits this endpoint to drive one round of every background poller.
//
// It lives under /webhooks/ because it is called server-to-server without
// a signed-in user. Protection is layered: an optional shared token
// (WATCHER_TICK_TOKEN — when set, callers must present it), a DB-backed
// throttle shared across all autoscale instances so public callers cannot
// hammer the Gmail/vendor APIs, and every tick being idempotent (in-flight
// runs are shared and completions/escalations durably deduped). The
// response never contains case data.
const WATCHER_TICK_AT_KEY = "watcher_last_tick_at";
const MIN_CRON_TICK_GAP_MS = 5_000;

/**
 * Atomically claim the next tick slot in onb_settings: the row only
 * updates when the stored ISO timestamp is older than the gap, so exactly
 * one caller per window wins even across concurrent instances.
 */
async function claimWatcherTickSlot(now: Date): Promise<boolean> {
  const cutoffIso = new Date(now.getTime() - MIN_CRON_TICK_GAP_MS).toISOString();
  const rows = await db
    .insert(onbSettings)
    // This is a platform lease, not tenant configuration. Keep it on the
    // stable platform/demo organization so an unauthenticated heartbeat never
    // derives its authority or scope from request tenant state.
    .values({ organizationId: DEMO_ORGANIZATION_ID, key: WATCHER_TICK_AT_KEY, value: now.toISOString() })
    .onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: now.toISOString(), updatedAt: sql`now()` },
      setWhere: sql`${onbSettings.value} < ${cutoffIso}`,
    })
    .returning({ key: onbSettings.key });
  return rows.length > 0;
}

const watcherTick = async (req: Request, res: Response) => {
  const requiredToken = process.env.WATCHER_TICK_TOKEN;
  if (requiredToken) {
    const presented =
      req.header("x-watcher-token") ?? String(req.query.token ?? "");
    if (presented !== requiredToken) {
      res.status(403).json({ message: "Invalid watcher tick token" });
      return;
    }
  }
  if (!(await claimWatcherTickSlot(new Date()))) {
    res.json({ ran: false, reason: "throttled" });
    return;
  }
  const { runContextRetentionTick } = await import("../lib/hro-context/retention");
  const [systemWatcher, emailWatch, inboundEmail, approverInbox, scenarioFiles, candidateAccess, connectedReadiness, contextRetention] = await Promise.all([
    runSystemWatcherTick(),
    runEmailWatchTick(),
    runInboundEmailTick(),
    runApproverInboxTick(),
    runScenarioFileMaintenance(),
    runCandidateAccessCleanup(),
    runConnectedReadinessTick(),
    runContextRetentionTick(),
  ]);
  res.json({
    ran: true,
    ranAt: new Date().toISOString(),
    systemWatcher,
    emailWatch,
    inboundEmail,
    approverInbox,
    scenarioFiles,
    candidateAccess,
    connectedReadiness,
    contextRetention,
  });
};

router.get("/onboarding/webhooks/watcher-tick", watcherTick);
router.post("/onboarding/webhooks/watcher-tick", watcherTick);

// An ambiguity means the email provider may have accepted a reviewer alert
// before the worker lost its response. Only an authenticated organization
// administrator may reconcile that provider-side result; the API intentionally
// accepts and returns no provider, receipt, or message identifiers.
router.get("/onboarding/external-audit-anchor-alerts/reconcile", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Organization owner or admin role required to view audit-alert delivery reconciliation.")) return;
    res.json({ ambiguousDeliveries: await getExternalAuditAnchorReviewerAmbiguousDeliveries(getOrganizationId(req)) });
  } catch (error) {
    next(error);
  }
});
router.post("/onboarding/external-audit-anchor-alerts/reconcile", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res, "Organization owner or admin role required to reconcile audit-alert delivery.")) return;
    const body = req.body as Record<string, unknown>;
    if (
      typeof body.episodeId !== "string" || !/^[0-9a-f-]{16,}$/i.test(body.episodeId) ||
      typeof body.attemptId !== "string" || !/^[0-9a-f-]{16,}$/i.test(body.attemptId) ||
      (body.kind !== "outage" && body.kind !== "recovery") ||
      (body.outcome !== "delivered" && body.outcome !== "not-delivered")
    ) {
      res.status(400).json({ message: "episodeId and attemptId must be opaque IDs; kind must be outage or recovery and outcome must be delivered or not-delivered." });
      return;
    }
    const reconciled = await reconcileExternalAuditAnchorReviewerAlert(getOrganizationId(req), {
      episodeId: body.episodeId,
      attemptId: body.attemptId,
      kind: body.kind,
      outcome: body.outcome,
    });
    if (reconciled === "not-found") {
      res.status(409).json({ message: "The selected ambiguous delivery is stale or no longer available." });
      return;
    }
    res.json({ reconciled: true });
  } catch (error) {
    next(error);
  }
});

/* ---------------------------- email watch ---------------------------- */

router.get("/onboarding/systems/email-watch", async (req, res, next) => {
  try {
    res.json(await getEmailWatchStatus(getOrganizationId(req)));
  } catch (err) {
    next(err);
  }
});

router.post(
  "/onboarding/systems/email-watch/simulate",
  async (req, res, next) => {
    try {
      const body = SimulateOnboardingWatchEmailBody.parse(req.body);
      const result = await simulateVendorEmail({
        ...body,
        organizationId: getOrganizationId(req),
        });
      res.status(result.ok ? 200 : 404).json(result);
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------ settings ----------------------------- */

async function settingsPayload(organizationId: string) {
  const stored = await getSetting(organizationId, HR_ALERT_EMAIL_KEY);
  const hrAlertEmail = stored && stored.trim().length > 0 ? stored.trim() : null;
  const envFallback = resolveHrAlertAddress(null);
  const effective = hrAlertEmail ?? envFallback;
  const [
    checklist,
    day1LogisticsDefault,
    candidateLinkRetentionDays,
    candidateAccessCleanup,
  ] = await Promise.all([
    getEffectiveChecklist(organizationId),
    getDay1LogisticsDefault(organizationId),
    getCandidateLinkRetentionDays(organizationId),
    getCandidateAccessCleanupHealth(),
  ]);
  return {
    hrAlertEmail,
    envFallback,
    effective,
    source: hrAlertEmail ? "settings" : envFallback ? "environment" : null,
    autoEscalationCalls: await autoEscalationCallsEnabled(organizationId),
    hrApproverEmail: await getSetting(organizationId, HR_APPROVER_EMAIL_KEY),
    checklistVersion: checklist.version,
    day1Checklist: checklist.items,
    day1LogisticsDefault,
    candidateLinkRetentionDays,
    candidateAccessCleanup,
  };
}

async function serializeChecklistProfile(
  organizationId: string,
  profile: Awaited<ReturnType<typeof listCurrentChecklistProfiles>>[number],
) {
  const base = await getEffectiveChecklist(organizationId);
  return {
    profileId: profile.profileId,
    version: profile.version,
    name: profile.name,
    criteria: profile.criteria,
    overrides: profile.overrides,
    processPolicy: profile.processPolicy,
    priority: profile.priority,
    enabled: profile.enabled,
    effectiveChecklist: applyChecklistOverrides(base.items, profile.overrides, profile.processPolicy?.semanticsVersion === 2),
    createdAt: profile.createdAt.toISOString(),
  };
}

router.get("/onboarding/checklist-profiles", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const profiles = await listCurrentChecklistProfiles(organizationId);
    res.json(await Promise.all(profiles.map((profile) => serializeChecklistProfile(organizationId, profile))));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/checklist-profiles/usage", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const rows = await db.select({
      checklistProfileId: onbCases.checklistProfileId,
      createdAt: onbCases.createdAt,
    }).from(onbCases).where(organizationWhere(onbCases, organizationId));
    res.json(summarizeChecklistProfileUsage(rows, new Date(), 90));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/workforce-policy-templates", (req, res) => {
  // Templates are reviewed starter guidance. They are organization-neutral
  // definitions; saving one remains an authenticated, tenant-scoped profile write.
  res.json(WORKFORCE_STARTER_TEMPLATES);
});

/* -------------------- cohort learning recommendations ------------------- */

function recommendationFingerprint(value: Record<string, unknown>): string | null {
  const fingerprint = value.evidenceFingerprint;
  return typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint
    : null;
}

function serializePolicyRecommendation(row: typeof onbPolicyRecommendations.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    recommendation: row.recommendation,
    evidenceSnapshot: row.evidenceSnapshot,
    decisionNote: row.decisionNote,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function recommendationWindow(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return [30, 90, 180, 365].includes(parsed) ? parsed : null;
}

async function cohortLearningAnalysis(organizationId: string, windowDays: number) {
  const asOf = new Date();
  const startedAt = new Date(asOf.getTime() - windowDays * 86_400_000);
  const [cases, events, profiles, approvals] = await Promise.all([
    db.select({
      id: onbCases.id,
      createdAt: onbCases.createdAt,
      scenarioKey: onbCases.scenarioKey,
      lifecycleStage: onbCases.lifecycleStage,
      checklistProfileId: onbCases.checklistProfileId,
      checklistProfileVersion: onbCases.checklistProfileVersion,
      checklistProfileName: onbCases.checklistProfileName,
      processPolicySnapshot: onbCases.processPolicySnapshot,
    }).from(onbCases).where(and(
      organizationWhere(onbCases, organizationId),
      gte(onbCases.createdAt, startedAt),
      lte(onbCases.createdAt, asOf),
    )),
    db.select({
      caseId: onbEvents.caseId,
      agent: onbEvents.agent,
      engine: onbEvents.engine,
      title: onbEvents.title,
      detail: onbEvents.detail,
      createdAt: onbEvents.createdAt,
    }).from(onbEvents).where(organizationWhere(onbEvents, organizationId)),
    listCurrentChecklistProfiles(organizationId),
    db.select({
      id: onbApprovals.id,
      caseId: onbApprovals.caseId,
      status: onbApprovals.status,
    }).from(onbApprovals).where(and(
      organizationWhere(onbApprovals, organizationId),
      sql`${onbApprovals.idempotencyKey} like 'gateway-c:%:human-queue'`,
    )),
  ]);
  const latestGateCApprovalByCase = new Map<number, { id: number; status: string }>();
  for (const approval of approvals) {
    const current = latestGateCApprovalByCase.get(approval.caseId);
    if (!current || approval.id > current.id) {
      latestGateCApprovalByCase.set(approval.caseId, approval);
    }
  }
  return analyzeCohortLearning({
    cases: cases.map((row) => ({
      ...row,
      gateCApprovalStatus: latestGateCApprovalByCase.get(row.id)?.status ?? null,
    })),
    events,
    profiles,
    asOf,
    windowDays,
    excludeAllAsDemo: organizationId === DEMO_ORGANIZATION_ID,
  });
}

router.get("/onboarding/policy-recommendations", async (req, res, next) => {
  try {
    const windowDays = recommendationWindow(req.query.windowDays) ?? 90;
    const organizationId = getOrganizationId(req);
    const [analysis, rows] = await Promise.all([
      cohortLearningAnalysis(organizationId, windowDays),
      db.select().from(onbPolicyRecommendations)
        .where(eq(onbPolicyRecommendations.organizationId, organizationId))
        .orderBy(desc(onbPolicyRecommendations.createdAt)),
    ]);
    res.json({ ...analysis, recommendations: rows.map(serializePolicyRecommendation) });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/policy-recommendations/refresh", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const windowDays = recommendationWindow(req.body?.windowDays) ?? 90;
    const organizationId = getOrganizationId(req);
    const analysis = await cohortLearningAnalysis(organizationId, windowDays);
    const created = await db.transaction(async (tx) => {
      const existing = await tx.select().from(onbPolicyRecommendations)
        .where(eq(onbPolicyRecommendations.organizationId, organizationId))
        .for("update");
      const existingFingerprints = new Set(existing.map((row) => recommendationFingerprint(row.evidenceSnapshot)).filter(Boolean));
      const rows = [];
      for (const candidate of analysis.recommendations) {
        const evidenceFingerprint = candidate.evidenceSnapshot.evidenceFingerprint;
        if (existingFingerprints.has(evidenceFingerprint)) continue;
        const [row] = await tx.insert(onbPolicyRecommendations).values({
          organizationId,
          status: "proposed",
          recommendation: candidate.recommendation,
          evidenceSnapshot: candidate.evidenceSnapshot,
        }).returning();
        rows.push(row);
      }
      return rows;
    });
    res.status(created.length ? 201 : 200).json({
      analysis: { ...analysis, recommendations: undefined },
      created: created.map(serializePolicyRecommendation),
      message: created.length
        ? "Evidence-scoped recommendations created for human review. No policy changed."
        : "No new recommendation was created. Existing evidence remains immutable, or the cohort is insufficient.",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/policy-recommendations/:id/decision", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ message: "Recommendation id must be a positive integer." });
      return;
    }
    if (body?.decision !== "accepted" && body?.decision !== "rejected") {
      res.status(400).json({ message: "decision must be accepted or rejected." });
      return;
    }
    if (typeof body.expectedEvidenceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedEvidenceFingerprint)) {
      res.status(400).json({ message: "A valid expectedEvidenceFingerprint is required to prevent a stale decision." });
      return;
    }
    const decisionNote = typeof body.decisionNote === "string" ? body.decisionNote.trim() : "";
    if (decisionNote.length > 1_000) {
      res.status(400).json({ message: "decisionNote must contain at most 1000 characters." });
      return;
    }
    const editedLearning = body.learning === undefined ? null : parseLearningPolicy(body.learning);
    if (body.learning !== undefined && !editedLearning) {
      res.status(400).json({ message: "Edited learning policy must include safe timing, sequence, channel, and ownership values." });
      return;
    }
    const organizationId = getOrganizationId(req);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(onbPolicyRecommendations).where(and(
        eq(onbPolicyRecommendations.id, id),
        eq(onbPolicyRecommendations.organizationId, organizationId),
      )).for("update");
      if (!row) throw Object.assign(new Error("Recommendation not found."), { name: "RecommendationNotFound" });
      if (row.status !== "proposed") throw Object.assign(new Error("This recommendation has already been decided and is immutable."), { name: "RecommendationDecided" });
      const fingerprint = recommendationFingerprint(row.evidenceSnapshot);
      if (!fingerprint || fingerprint !== body.expectedEvidenceFingerprint) {
        throw Object.assign(new Error("Evidence version changed or is invalid. Reload before deciding."), { name: "RecommendationVersionConflict" });
      }
      if (body.decision === "rejected") {
        const [rejected] = await tx.update(onbPolicyRecommendations).set({
          status: "rejected",
          decisionNote: decisionNote || null,
          decidedBy: req.authUserId!,
          decidedAt: new Date(),
        }).where(eq(onbPolicyRecommendations.id, row.id)).returning();
        return { row: rejected, published: null };
      }
      const proposed = row.recommendation as Record<string, unknown>;
      const target = proposed.target as Record<string, unknown> | undefined;
      if (
        proposed.type !== "cohort-learning-default" ||
        !target ||
        typeof target.profileId !== "string" ||
        !Number.isInteger(target.expectedProfileVersion) ||
        !parseLearningPolicy(proposed.learning)
      ) throw Object.assign(new Error("Stored recommendation is invalid and cannot be published."), { name: "RecommendationInvalid" });
      const current = (await listCurrentChecklistProfiles(organizationId, tx))
        .find((profile) => profile.profileId === target.profileId);
      if (!current || !current.enabled || current.version !== target.expectedProfileVersion) {
        throw Object.assign(new Error("The target profile changed after this evidence was captured. Reload and refresh the analysis; no policy was published."), { name: "RecommendationVersionConflict" });
      }
      const learning = (editedLearning ?? parseLearningPolicy(proposed.learning)) as LearningPolicy;
      // Named task/escalation assignees are stable authenticated tenant user
      // IDs, never free-form labels. Verify every referenced ID at publish
      // time so a stale editor cannot publish an orphaned assignment.
      const assignedUserIds = new Set((learning.steps ?? []).flatMap((step) => {
        const timing = step.timing && typeof step.timing === "object"
          ? step.timing as Record<string, unknown> : {};
        const escalation = timing.escalation && typeof timing.escalation === "object"
          ? timing.escalation as Record<string, unknown> : {};
        return [step.assignedTo, escalation.assignedTo];
      }).filter((value): value is string => typeof value === "string" && value.length > 0));
      if (assignedUserIds.size) {
        const currentMembers = await tx.select({ userId: organizationMembershipsTable.clerkUserId })
          .from(organizationMembershipsTable)
          .where(and(
            eq(organizationMembershipsTable.organizationId, organizationId),
            isNull(organizationMembershipsTable.revokedAt),
          ));
        const memberIds = new Set(currentMembers.map((member) => member.userId));
        const unknown = [...assignedUserIds].find((userId) => !memberIds.has(userId));
        if (unknown) throw Object.assign(new Error(`Assigned specialist ${unknown} is not a current tenant member.`), { name: "RecommendationInvalid" });
      }
      // Compile the exact value immediately before publication. Runtime has a
      // human-review fallback for old malformed snapshots, but adoption must
      // fail closed rather than publishing metadata with no executable task.
      const runtimeIssue = learningPolicyRuntimeIssue(learning);
      if (runtimeIssue) {
        throw Object.assign(new Error(`Learning policy is not executable by the workforce-step runtime: ${runtimeIssue}`), { name: "RecommendationInvalid" });
      }
      // Only the learning-default subdocument is changed. Checklist overrides
      // and other process controls are copied exactly, so acceptance cannot
      // waive a compliance or independently evidenced gate.
      const published = await saveChecklistProfileInTransaction(tx, organizationId, current.profileId, current.version, {
        name: current.name,
        criteria: current.criteria,
        overrides: current.overrides,
        priority: current.priority,
        enabled: current.enabled,
        processPolicy: { ...current.processPolicy, learning },
      }, req.authUserId!);
      const publicationNote = `Published future-case profile v${published.version}.${decisionNote ? ` ${decisionNote}` : ""}`;
      const [accepted] = await tx.update(onbPolicyRecommendations).set({
        status: "accepted",
        decisionNote: publicationNote,
        decidedBy: req.authUserId!,
        decidedAt: new Date(),
      }).where(eq(onbPolicyRecommendations.id, row.id)).returning();
      return { row: accepted, published: { profileId: published.profileId, version: published.version } };
    });
    res.json({ ...serializePolicyRecommendation(result.row), published: result.published, futureCasesOnly: true });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const status = name === "RecommendationNotFound" ? 404
      : name === "RecommendationVersionConflict" || name === "RecommendationDecided" ? 409
        : name === "RecommendationInvalid" ? 400 : undefined;
    if (status) {
      res.status(status).json({ message: err instanceof Error ? err.message : "Could not decide recommendation." });
      return;
    }
    next(err);
  }
});

router.post("/onboarding/checklist-profiles", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    const body = CreateOnboardingChecklistProfileBody.parse(req.body);
    try {
      const created = await saveChecklistProfile(organizationId, null, null, body, req.authUserId!);
      res.status(201).json(await serializeChecklistProfile(organizationId, created));
    } catch (error) {
      res.status(error instanceof Error && error.name === "ProfileAmbiguity" ? 409 : 400)
        .json({ message: error instanceof Error ? error.message : "Invalid checklist profile." });
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/onboarding/checklist-profiles/:profileId", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    const body = UpdateOnboardingChecklistProfileBody.parse(req.body);
    const { expectedVersion, ...input } = body;
    try {
      const created = await saveChecklistProfile(
        organizationId,
        String(req.params.profileId),
        expectedVersion,
        input,
        req.authUserId!,
      );
      res.json(await serializeChecklistProfile(organizationId, created));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const status = name === "ProfileNotFound" ? 404 : name === "ProfileVersionConflict" || name === "ProfileAmbiguity" ? 409 : 400;
      res.status(status).json({ message: error instanceof Error ? error.message : "Invalid checklist profile." });
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/onboarding/checklist-profiles/:profileId", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    try {
      const disabled = await disableChecklistProfile(
        organizationId,
        String(req.params.profileId),
        req.authUserId!,
      );
      res.json(await serializeChecklistProfile(organizationId, disabled));
    } catch (error) {
      const status = error instanceof Error && error.name === "ProfileNotFound" ? 404 : 400;
      res.status(status).json({ message: error instanceof Error ? error.message : "Invalid checklist profile." });
    }
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/checklist-profiles/:profileId/duplicate", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    const profile = (await listCurrentChecklistProfiles(organizationId))
      .find((candidate) => candidate.profileId === String(req.params.profileId));
    if (!profile) {
      res.status(404).json({ message: "Checklist profile not found." });
      return;
    }
    const created = await saveChecklistProfile(organizationId, null, null, {
      name: `${profile.name} copy`,
      criteria: profile.criteria,
      overrides: profile.overrides,
      processPolicy: profile.processPolicy,
      priority: profile.priority,
      enabled: false,
    }, req.authUserId!);
    res.status(201).json(await serializeChecklistProfile(organizationId, created));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/settings", async (req, res, next) => {
  try {
    res.json(await settingsPayload(getOrganizationId(req)));
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/settings", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const organizationId = getOrganizationId(req);
    const body = UpdateOnboardingSettingsBody.parse(req.body);
    const hrAlertEmail =
      body.hrAlertEmail === undefined ? undefined : (body.hrAlertEmail ?? "").trim() || null;
    const hrApproverEmail =
      body.hrApproverEmail === undefined ? undefined : (body.hrApproverEmail ?? "").trim() || null;
    let logisticsDefault;
    // Validate the complete request before performing any write.
    if (hrAlertEmail && !isValidEmail(hrAlertEmail)) {
      res.status(400).json({ error: "Enter a valid email address (e.g. hr@company.com)." });
      return;
    }
    if (hrApproverEmail && !isValidEmail(hrApproverEmail)) {
      res.status(400).json({ error: "Enter a valid email address for the HR approver." });
      return;
    }
    if (body.day1Checklist !== undefined && body.expectedChecklistVersion === undefined) {
      res.status(400).json({ error: "expectedChecklistVersion is required when updating the checklist." });
      return;
    }
    if (body.day1Checklist === undefined && body.expectedChecklistVersion !== undefined) {
      res.status(400).json({ error: "day1Checklist is required with expectedChecklistVersion." });
      return;
    }
    if (body.day1LogisticsDefault !== undefined) {
      try {
        logisticsDefault = validateDay1LogisticsDefault(body.day1LogisticsDefault);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid Day-1 logistics default." });
        return;
      }
    }
    if (
      body.candidateLinkRetentionDays !== undefined
      && !isAllowedCandidateLinkRetentionDays(body.candidateLinkRetentionDays)
    ) {
      res.status(400).json({ error: "Candidate-link retention must be 30, 90, 180, or 365 days." });
      return;
    }
    if (body.day1Checklist !== undefined) {
      try {
        await saveChecklistVersion(
          organizationId,
          body.expectedChecklistVersion!,
          body.day1Checklist,
          req.authUserId!,
          async (tx) => {
            const profiles = await listCurrentChecklistProfiles(organizationId, tx);
            validateProfilesAgainstBase({ items: body.day1Checklist! }, profiles);
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === "ChecklistVersionConflict") {
          res.status(409).json({ error: error.message });
          return;
        }
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid checklist." });
        return;
      }
    }
    if (logisticsDefault !== undefined) {
      await setDay1LogisticsDefault(organizationId, logisticsDefault);
    }
    if (body.hrAlertEmail !== undefined) {
      await setSetting(organizationId, HR_ALERT_EMAIL_KEY, hrAlertEmail ?? null);
    }
    if (body.autoEscalationCalls !== undefined) {
      await setSetting(organizationId, AUTO_ESCALATION_CALLS_KEY, body.autoEscalationCalls ? "on" : null);
    }
    if (body.hrApproverEmail !== undefined) {
      await setSetting(organizationId, HR_APPROVER_EMAIL_KEY, hrApproverEmail ?? null);
      // The approver address doubles as a live-delivery authorization —
      // apply the change to the in-process allowlist immediately.
      await refreshDemoAllowlist(organizationId);
    }
    if (body.candidateLinkRetentionDays !== undefined) {
      await setSetting(
        organizationId,
        CANDIDATE_LINK_RETENTION_DAYS_KEY,
        String(body.candidateLinkRetentionDays),
      );
    }
    res.json(await settingsPayload(organizationId));
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- guardrails ----------------------------- */

router.get("/onboarding/guardrails", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const counts = await db
      .select({
        key: onbGuardrailEvents.guardrailKey,
        count: sql<number>`count(*)::int`,
        lastAt: sql<string | null>`max(${onbGuardrailEvents.createdAt})`,
      })
      .from(onbGuardrailEvents)
      .where(organizationWhere(onbGuardrailEvents, organizationId))
      .groupBy(onbGuardrailEvents.guardrailKey);
    const byKey = new Map(counts.map((c) => [c.key, c]));
    res.json({
      categories: Object.entries(GUARDRAIL_CATEGORIES).map(([key, v]) => ({ key, ...v })),
      guardrails: GUARDRAILS.map((g) => ({
        ...g,
        activationCount: byKey.get(g.key)?.count ?? 0,
        lastActivatedAt: byKey.get(g.key)?.lastAt ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/guardrails/:key/events", async (req, res, next) => {
  try {
    const guardrail = getGuardrail(req.params.key);
    if (!guardrail) {
      res.status(404).json({ message: `Unknown guardrail "${req.params.key}"` });
      return;
    }
    const rows = await db
      .select({
        id: onbGuardrailEvents.id,
        caseId: onbGuardrailEvents.caseId,
        action: onbGuardrailEvents.action,
        detail: onbGuardrailEvents.detail,
        createdAt: onbGuardrailEvents.createdAt,
        workerName: onbCases.workerName,
      })
      .from(onbGuardrailEvents)
      .leftJoin(onbCases, and(
        eq(onbGuardrailEvents.caseId, onbCases.id),
        eq(onbGuardrailEvents.organizationId, onbCases.organizationId),
      ))
      .where(and(
        eq(onbGuardrailEvents.guardrailKey, req.params.key),
        organizationWhere(onbGuardrailEvents, getOrganizationId(req)),
      ))
      .orderBy(desc(onbGuardrailEvents.createdAt), desc(onbGuardrailEvents.id))
      .limit(50);
    const visibleRows = await Promise.all(rows.map(async (r) => {
      if (r.caseId === null) {
        return { ...r, createdAt: r.createdAt.toISOString() };
      }
      const caseAccess = await caseGovernanceAccessForRequest(req, {
        organizationId: getOrganizationId(req),
        id: r.caseId,
      });
      if (!caseAccess.flowRead) return null;
      const sensitiveAccess = await sensitiveAccessForCase(req, {
        organizationId: getOrganizationId(req),
        id: r.caseId,
      });
      return {
        ...r,
        workerName: caseAccess.profileRead && sensitiveAccess.identity
          ? r.workerName
          : "Restricted candidate",
        detail: caseAccess.profileRead && caseAccess.notesRead
          ? redactSensitiveText(r.detail, sensitiveAccess) ?? "Restricted case event."
          : "Restricted case event.",
        createdAt: r.createdAt.toISOString(),
      };
    }));
    res.json(visibleRows.filter((row) => row !== null));
  } catch (err) {
    next(err);
  }
});

const lastDrillAt = new Map<string, number>();
router.post("/onboarding/guardrails/drill", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const previous = lastDrillAt.get(organizationId) ?? 0;
    if (Date.now() - previous < 120_000) {
      res.status(429).json({ message: "A drill just ran — wait a couple of minutes before running another." });
      return;
    }
    lastDrillAt.set(organizationId, Date.now());
    const result = await runSecurityDrill(organizationId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/* --------------------------- demo volunteers --------------------------- */

/* --------------------------- system watcher --------------------------- */

router.get("/onboarding/systems/watcher", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    await ensureConnectorsSeeded(organizationId);
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId))
      .orderBy(desc(onbSystemChecks.id));
    res.json({
      connectors: getSystemWatcherHealth(),
      malwareScanner: await getMalwareScannerMonitorHealth(),
      checks: (await Promise.all(rows.map(async ({ check: c, workerName }) => {
        const caseAccess = await caseGovernanceAccessForRequest(req, {
          organizationId,
          id: c.caseId,
        });
        if (!caseAccess.flowRead) return null;
        const sensitiveAccess = await resolveSensitiveAccess({
          organizationId,
          caseId: c.caseId,
          actorUserId: req.authUserId,
        });
        if ((c.system === "bgv" && !sensitiveAccess.bgv) || (c.system === "payroll" && !sensitiveAccess.payroll)) {
          return {
            id: c.id,
            caseId: c.caseId,
            caseWorkerName: sensitiveAccess.identity && caseAccess.profileRead
              ? workerName
              : "Restricted candidate",
            system: c.system,
            label: c.system === "bgv" ? "Restricted background-verification check" : "Restricted payroll check",
            status: c.status,
            restricted: true,
          };
        }
        const canReadNarratives = caseAccess.profileRead &&
          caseAccess.notesRead &&
          hasOpaqueNarrativeAccess(sensitiveAccess);
        return {
        id: c.id,
        caseId: c.caseId,
        caseWorkerName: sensitiveAccess.identity && caseAccess.profileRead
          ? workerName
          : "Restricted candidate",
        system: c.system,
        label: systemDef(c.system)?.label ?? c.system,
        mode: c.mode,
        externalRef: canReadNarratives ? c.externalRef : undefined,
        status: c.status,
        requestedAt: c.requestedAt.toISOString(),
        dueAt: c.dueAt.toISOString(),
        completedAt: iso(c.completedAt),
        lastCheckedAt: iso(c.lastCheckedAt),
        escalatedAt: iso(c.escalatedAt),
        note: canReadNarratives
          ? c.note
          : "System-provider narrative details are restricted to the assigned confidential-record reviewers.",
        ...(canReadNarratives ? {} : { restrictedNarratives: true }),
        };
      }))).filter((row) => row !== null),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Vendor status webhook (push pattern, e.g. BGV clearance). Public
 * server-to-server endpoint authenticated by a shared token; the
 * in-process simulated vendor uses the same handleSystemWebhook code
 * path directly.
 */
router.post("/onboarding/webhooks/systems/:system", async (req, res, next) => {
  try {
    const token = process.env.ONB_SYSTEM_WEBHOOK_TOKEN;
    if (!token) {
      res.status(503).json({ message: "System webhook token is not configured" });
      return;
    }
    if (req.header("x-webhook-token") !== token) {
      res.status(403).json({ message: "Invalid webhook token" });
      return;
    }
    const caseId = Number(req.body?.caseId);
    const externalRef = String(req.body?.externalRef ?? "");
    const status = String(req.body?.status ?? "");
    if (!Number.isInteger(caseId) || !externalRef || !status) {
      res.status(400).json({ message: "caseId (number), externalRef, and status are required" });
      return;
    }
    const result = await handleSystemWebhook({
      system: req.params.system,
      caseId,
      externalRef,
      status,
      // This route is the sole trusted real-provider boundary. The
      // in-process watcher calls the handler directly with simulated
      // provenance and never reaches this route.
      provenance: "trusted-provider",
    });
    res.status(result.ok ? 200 : result.message.startsWith("Unsupported") ? 400 : 404).json({ message: result.message });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- analytics ----------------------------- */

const SUPPRESSION_THRESHOLD = 3;

/** Aggregate/reporting views must not learn from UAT cases or their events. */
async function excludeUatAggregateCases<T extends {
  id: number;
  organizationId: string;
  scenarioKey?: string | null;
  syntheticProvenance?: OnbSyntheticProvenance | null;
  notes?: string | null;
}>(rows: T[]): Promise<T[]> {
  const isolated = await Promise.all(rows.map(async (row) =>
    (await getUatCaseIsolation(row)).isolated,
  ));
  return rows.filter((row, index) => !isolated[index] && !isHistoricalTestRecord(row));
}

async function loadOutcomeKpis(req: Request) {
    const rawDomain =
      typeof req.query.domain === "string"
        ? req.query.domain
        : req.query.domain === undefined
          ? undefined
          : String(req.query.domain);
    const supportedDomain =
      rawDomain === undefined ||
      rawDomain === "Onboarding" ||
      rawDomain === "All domains";
    // An older frontend may send another domain value. Return an empty
    // eligible cohort instead of guessing across unsupported domains.
    const parsed = GetOnboardingOutcomeKpisQueryParams.safeParse({
      period: req.query.period,
      region: req.query.region,
      hireType: req.query.hireType,
      domain: supportedDomain ? rawDomain : undefined,
    });
    if (!parsed.success) {
      throw parsed.error;
    }

    const organizationId = getOrganizationId(req);
    const asOf = new Date();
    const period = parsed.data.period ?? "30";
    const periodDays = period === "All" ? null : Number(period);
    const lowerBound =
      periodDays === null
        ? null
        : new Date(asOf.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const caseFilters = [
      organizationWhere(onbCases, organizationId),
      lte(onbCases.createdAt, asOf),
      ...(lowerBound ? [gte(onbCases.createdAt, lowerBound)] : []),
      ...(parsed.data.region ? [eq(onbCases.geography, parsed.data.region)] : []),
      ...(parsed.data.hireType ? [eq(onbCases.hireType, parsed.data.hireType)] : []),
    ];
    const cases = supportedDomain
      ? (await excludeUatAggregateCases(await db
          .select()
          .from(onbCases)
          .where(and(...caseFilters))))
          // Synthetic reset and retired controller cases are deliberately not
          // evidence of a genuine onboarding outcome. Keep their simulated
          // activity visible on their own run timeline, never in KPI cohorts.
          .filter((candidate) =>
            !isSyntheticOfflineCase(candidate) &&
            !isRetiredControllerCase(candidate) &&
            (candidate.scenarioKey === null || candidate.scenarioKey === undefined),
          )
      : [];

    const caseIds = cases.map((row) => row.id);
    let events: OutcomeEvent[] = [];
    let bgvChecks: OutcomeBgvCheck[] = [];
    let bgvEmails: OutcomeBgvEmail[] = [];
    let surveyResponses: Awaited<ReturnType<typeof loadOutcomeReportingEvidence>>["surveyResponses"] = [];
    let employmentEvidence: Awaited<ReturnType<typeof loadOutcomeReportingEvidence>>["employmentEvidence"] = [];
    const gateCApprovalByCase = new Map<number, { id: number; status: string }>();
    if (caseIds.length > 0) {
      const [eventRows, checkRows, emailRows, approvalRows, reportingEvidence] = await Promise.all([
        db
          .select({ event: onbEvents })
          .from(onbEvents)
          .innerJoin(
            onbCases,
            and(
              eq(onbEvents.caseId, onbCases.id),
              eq(onbEvents.organizationId, onbCases.organizationId),
            ),
          )
          .where(
            and(
              organizationWhere(onbEvents, organizationId),
              inArray(onbCases.id, caseIds),
            ),
          ),
        db
          .select({ check: onbSystemChecks })
          .from(onbSystemChecks)
          .innerJoin(
            onbCases,
            and(
              eq(onbSystemChecks.caseId, onbCases.id),
              eq(onbSystemChecks.organizationId, onbCases.organizationId),
            ),
          )
          .where(
            and(
              organizationWhere(onbSystemChecks, organizationId),
              inArray(onbCases.id, caseIds),
              eq(onbSystemChecks.system, "bgv"),
            ),
          ),
        db
          .select({ email: onbWatchEmails })
          .from(onbWatchEmails)
          .innerJoin(
            onbSystemChecks,
            and(
              eq(onbWatchEmails.checkId, onbSystemChecks.id),
              eq(onbWatchEmails.organizationId, onbSystemChecks.organizationId),
            ),
          )
          .innerJoin(
            onbCases,
            and(
              eq(onbWatchEmails.caseId, onbCases.id),
              eq(onbWatchEmails.organizationId, onbCases.organizationId),
            ),
          )
          .where(
            and(
              organizationWhere(onbWatchEmails, organizationId),
              inArray(onbCases.id, caseIds),
              eq(onbSystemChecks.system, "bgv"),
            ),
          ),
        db
          .select({
            caseId: onbApprovals.caseId,
            id: onbApprovals.id,
            status: onbApprovals.status,
          })
          .from(onbApprovals)
          .innerJoin(
            onbCases,
            and(
              eq(onbApprovals.caseId, onbCases.id),
              eq(onbApprovals.organizationId, onbCases.organizationId),
            ),
          )
          .where(
            and(
              organizationWhere(onbApprovals, organizationId),
              inArray(onbCases.id, caseIds),
              sql`${onbApprovals.idempotencyKey} like 'gateway-c:%:human-queue'`,
            ),
          ),
        loadOutcomeReportingEvidence(organizationId, caseIds),
      ]);
      events = eventRows.map(({ event }) => event);
      bgvChecks = checkRows.map(({ check }) => check);
      bgvEmails = emailRows.map(({ email }) => email);
      surveyResponses = reportingEvidence.surveyResponses;
      employmentEvidence = reportingEvidence.employmentEvidence;
      for (const approval of approvalRows) {
        const current = gateCApprovalByCase.get(approval.caseId);
        if (!current || approval.id > current.id) {
          gateCApprovalByCase.set(approval.caseId, {
            id: approval.id,
            status: approval.status,
          });
        }
      }
    }

    const casesForCalculation = cases.map((row) => ({
      ...row,
      gateCApprovalStatus: gateCApprovalByCase.get(row.id)?.status ?? null,
    }));
    return calculateOutcomeKpis({
      cases: casesForCalculation,
      events,
      bgvChecks,
      bgvEmails,
      surveyResponses,
      employmentEvidence,
      asOf,
      period,
      region: parsed.data.region,
      hireType: parsed.data.hireType,
      domain: supportedDomain ? parsed.data.domain : rawDomain,
    });
}

router.get("/onboarding/analytics/outcome-kpis", async (req, res, next) => {
  try {
    res.json(await loadOutcomeKpis(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Aggregate-only handoff for the analytics team while a Power BI connector is
 * pending. The request needs both an administrative role and a live,
 * server-verified privacy/legal assignment; ordinary KPI viewing does not
 * disclose this export surface.
 */
router.get("/onboarding/analytics/outcome-kpis/export", async (req, res, next) => {
  try {
    if (req.query.format !== undefined && req.query.format !== "json" && req.query.format !== "csv") {
      res.status(400).json({ message: "format must be json or csv." });
      return;
    }
    if (!isChecklistAdministrator(req.organizationRole) || !req.authUserId) {
      res.status(403).json({ message: "Organization owner or admin role and an authenticated principal are required for analytics export." });
      return;
    }
    const organizationId = getOrganizationId(req);
    try {
      await db.transaction((tx) => verifiedSensitiveAuthorityInTransaction(
        tx,
        organizationId,
        req.authUserId!,
      ));
    } catch (error) {
      if (error instanceof SensitiveLifecyclePermissionError) {
        res.status(403).json({ message: error.message });
        return;
      }
      throw error;
    }
    const exported = privacyScopedOutcomeExport(await loadOutcomeKpis(req));
    await appendProtectedAudit({
      organizationId,
      actorId: req.authUserId,
      actorKind: "authenticated",
      actorAuthority: `tenant-membership:${req.organizationRole};privacy-or-legal:verified`,
      action: "onboarding.analytics.outcome-kpis.export",
      outcome: "success",
      objectType: "privacy-scoped-outcome-export",
      source: "http",
      correlationId: req.header("x-request-id") ?? req.header("x-correlation-id") ?? null,
      payload: {
        exportFormat: req.query.format === "csv" ? "csv" : "json",
        integrationState: exported.integrationState,
        individualLevelDataIncluded: false,
      },
    });
    if (req.query.format === "csv") {
      res.type("text/csv").attachment("onboarding-outcome-aggregates.csv")
        .send(privacyScopedOutcomeExportCsv(exported));
      return;
    }
    res.json(exported);
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/analytics", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const cases = await demoPrincipalVisibleCases(req, await excludeUatAggregateCases(await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, organizationId))));
    const readinessCases = (await Promise.all(cases.map(async (row) => {
      const access = await caseGovernanceAccessForRequest(req, row);
      return access.flowRead && access.readinessRead ? row : null;
    }))).filter((row): row is typeof cases[number] => row !== null);
    const aggregateCaseIds = new Set(cases.map((row) => row.id));
    const readinessCaseIds = new Set(readinessCases.map((row) => row.id));

    const approvalRows = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId));
    const approvals = approvalRows
      .map(({ approval }) => approval)
      .filter((approval) =>
        aggregateCaseIds.has(approval.caseId) &&
        (!isDay1ReadinessApproval(approval) || readinessCaseIds.has(approval.caseId)));

    const skillMap = new Map<string, { count: number; criticality: string }>();
    for (const c of cases) {
      if (!c.primarySkill) continue;
      const cur = skillMap.get(c.primarySkill) ?? {
        count: 0,
        criticality: c.skillCriticality ?? "standard",
      };
      cur.count += 1;
      if (c.skillCriticality && c.skillCriticality !== "standard") {
        cur.criticality = c.skillCriticality;
      }
      skillMap.set(c.primarySkill, cur);
    }
    const skillInflow = Array.from(skillMap.entries()).map(([skill, v]) => {
      // Cohort suppression applies before any presentation or downstream
      // processing. A standard criticality label is still an opaque,
      // organization-specific skill label and cannot make a small cohort safe.
      const suppressed = v.count < SUPPRESSION_THRESHOLD;
      return {
        skill: suppressed ? "Suppressed (small population)" : skill,
        count: v.count,
        criticality: v.criticality,
        suppressed,
      };
    });

    const themeMap = new Map<string, number>();
    for (const a of approvals) {
      const theme = a.agent === "documentation" ? "documentation" : a.agent === "access" ? "access" : a.agent === "assets" ? "assets" : "intake-review";
      themeMap.set(theme, (themeMap.get(theme) ?? 0) + 1);
    }
    const bottlenecks = Array.from(themeMap.entries()).map(([theme, occurrences]) => ({
      theme,
      occurrences,
      note:
        theme === "documentation"
          ? "Documentation & compliance items pausing cases for human review"
          : theme === "intake-review"
            ? "Intake classifications requiring human approval before planning"
            : `Readiness reviews raised by the ${theme} workstream`,
    }));

    const readinessMap = new Map<string, number>();
    for (const c of readinessCases) {
      const key = c.readiness.every((r) => r.status === "ready")
        ? "day1-ready"
        : c.lifecycleStage === "exception"
          ? "exception"
          : "in-progress";
      readinessMap.set(key, (readinessMap.get(key) ?? 0) + 1);
    }

    // Analytics has no case-scoped governance snapshot that could authorize
    // provider disclosure of opaque skill labels or small cohort attributes.
    // Keep its narrative local and deterministic; it is derived only from
    // already-suppressed aggregate counts and never invokes an LLM.
    const pendingReviewCount = approvals.filter((a) => a.status === "pending").length;
    const narrative = cases.length === 0
      ? null
      : `${cases.length} onboarding cases are represented in this aggregate. ${
        pendingReviewCount > 0
          ? `${pendingReviewCount} human review${pendingReviewCount === 1 ? " is" : "s are"} pending.`
          : "No human reviews are currently pending."
      } Readiness is reported only as aggregate status counts; skill cohorts below ${
        SUPPRESSION_THRESHOLD
      } are suppressed.`;

    res.json({
      skillInflow,
      bottlenecks,
      cohortReadiness: Array.from(readinessMap.entries()).map(([key, count]) => ({ key, count })),
      suppressionThreshold: SUPPRESSION_THRESHOLD,
      narrative,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ channels ----------------------------- */

router.get("/onboarding/channels", async (req, res, next) => {
  try {
    res.json({
      email: emailChannelInfo(),
      whatsapp: whatsappChannelInfo(),
      blockedPublishBackup: blockedPublishBackupReadiness(),
      inboundEmail: await getInboundEmailMonitorStatus(getOrganizationId(req)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/channels/test", async (req, res, next) => {
  try {
    const body = TestOnboardingChannelBody.parse(req.body);
    if (body.channel !== "email" && body.channel !== "whatsapp") {
      res.status(200).json({ ok: false, detail: "channel must be 'email' or 'whatsapp'" });
      return;
    }
    // Find (or create) a system case to attach the test message to.
    const [anyCase] = await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, getOrganizationId(req)))
      .orderBy(desc(onbCases.id))
      .limit(1);
    if (!anyCase) {
      res.json({ ok: false, detail: "Run a scenario first so there is a case to attach the test message to." });
      return;
    }
    const info = body.channel === "email" ? emailChannelInfo() : whatsappChannelInfo();
    const to = body.channel === "email"
      ? systemEmailTestAddress() ?? ""
      : anyCase.workerPhone ?? "";
    if (body.channel === "email" && !to) {
      res.json({
        ok: false,
        detail: "Set ONBOARDING_CHANNEL_TEST_EMAIL to an address explicitly listed in ONBOARDING_ALLOWED_RECIPIENTS before sending an email channel test.",
      });
      return;
    }
    if (body.channel === "whatsapp" && !to) {
      res.json({ ok: false, detail: "No case has a WhatsApp phone number yet — add one via the intake form." });
      return;
    }
    const testBody = `This is a test message from the Onboarding Agent Control Tower (${new Date().toISOString()}).`;
    const result = body.channel === "email"
      ? await sendAdministrativeEmail({
          caseId: anyCase.id,
          toAddress: to,
          subject: "Onboarding channel test",
          body: testBody,
        })
      : await sendOutbound({
          caseId: anyCase.id,
          channel: "whatsapp",
          toAddress: to,
          subject: null,
          body: testBody,
        });
    res.json({
      ok: result.status === "sent",
      detail:
        result.status === "sent"
          ? `Test message delivered via ${info.provider}.`
          : result.status === "logged-only"
            ? `Channel not connected (${info.note}) — message was logged to case #${anyCase.id} instead.`
            : `Send failed: ${result.failureReason}`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
