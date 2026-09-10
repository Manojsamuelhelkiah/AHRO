import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, asc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DEMO_ORGANIZATION_ID,
  onbApprovals,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbEvents,
  onbCaseLogistics,
  onbSettings,
  onbSystemChecks,
  onbCandidateUploads,
  onbDocuments,
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
} from "@workspace/api-zod";
import {
  defaultReadiness,
  defaultWorkstreams,
  handleInbound,
  resumeAfterDecision,
  startOrchestration,
} from "../lib/onboarding/engine";
import { isChecklistAdministrator, setCustomChecklistItemStatus } from "../lib/onboarding/checklist";
import { getScenario, SCENARIOS, DEMO_EMAIL } from "../lib/onboarding/scenarios";
import { ensureConnectorsSeeded } from "../lib/onboarding/connectors";
import {
  blockedPublishBackupReadiness,
  emailChannelInfo,
  sendOutbound,
  sendAdministrativeEmail,
  systemEmailTestAddress,
  retryCandidateEmail,
  whatsappChannelInfo,
} from "../lib/onboarding/channels";
import { llmComplete } from "../lib/onboarding/llm";
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
} from "../lib/onboarding/settings";
import { logisticsForCase, validateDay1LogisticsDefault } from "../lib/onboarding/logistics-defaults";
import {
  AUTOMATED_PORTAL_EMAIL_KEY,
  issueCandidatePortalLink,
  portalPublicBase,
} from "../lib/onboarding/portal-link-issuance";
import { loadVolunteers, saveVolunteers, seedVolunteerCases, listPersonas, refreshDemoAllowlist } from "../lib/onboarding/demo-volunteers";
import { runApproverInboxTick } from "../lib/onboarding/approver-email";
import { GUARDRAILS, GUARDRAIL_CATEGORIES, getGuardrail, recordGuardrailEvent } from "../lib/onboarding/guardrails";
import { runSecurityDrill } from "../lib/onboarding/security-drill";
import { onbGuardrailEvents } from "@workspace/db/schema";
import { twilioSignatureValid } from "../lib/onboarding/twilio-signature";
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
import { systemDef, WATCHED_SYSTEMS } from "../lib/onboarding/external-systems";
import { normalizePreference, shouldAuthorizeCandidateEmail } from "../lib/onboarding/channel-routing";
import {
  getCandidateAccessCleanupHealth,
  runCandidateAccessCleanup,
} from "../lib/onboarding/candidate-access-cleanup";
import { resolveReviewerName } from "../middlewares/require-auth";
import { normalizeBgvStatus } from "../lib/onboarding/document-validation";
import { reconcileDocumentationReadiness } from "../lib/onboarding/document-validation";
import { requeueDocumentMalwareScan } from "../lib/onboarding/document-malware";
import { malwareScanRetryable, malwareUploadIsClean } from "../lib/onboarding/malware-policy";
import { clerkClient } from "@clerk/express";
import {
  getOrganizationId,
  organizationValues,
  organizationWhere,
} from "../lib/organization-scope";
import {
  activeReplacementDecision,
  applyChecklistOverrides,
  disableChecklistProfile,
  listCurrentChecklistProfiles,
  mergeChecklistReadiness,
  resolveChecklistProfile,
  resolveChecklistProfileInTransaction,
  saveChecklistProfile,
  validateProfilesAgainstBase,
} from "../lib/onboarding/checklist-profiles";

const router: IRouter = Router();
const malwareScanCanRetry = (state: string | null | undefined) => !!state && malwareScanRetryable(state);

function requireHrChecklistRole(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({ message: "Organization owner or admin role required for checklist administration." });
  return false;
}

/**
 * One-click demo sign-in. The shared demo reviewer account uses an
 * undeliverable @example.com address, so Clerk's email-code device
 * verification can never complete for it. This endpoint issues a one-time
 * Clerk sign-in ticket for THAT ACCOUNT ONLY (equivalent access to the
 * already-public demo credentials — no other account can be minted).
 */
const DEMO_LOGIN_EMAIL = "demo.reviewer@example.com";
// Publicly documented demo credential (also prefilled on the login page).
const DEMO_LOGIN_PASSWORD = "OnboardOS-Demo-2026!";

/**
 * Finds the demo reviewer account, creating it if it does not exist yet.
 * Production runs against a separate Clerk instance from development, so the
 * account must be self-healing — otherwise a fresh publish has no demo user.
 * Handles the create/create race by re-fetching on a creation conflict.
 */
async function ensureDemoUser() {
  const found = await clerkClient.users.getUserList({ emailAddress: [DEMO_LOGIN_EMAIL] });
  if (found.data[0]) return found.data[0];
  try {
    return await clerkClient.users.createUser({
      emailAddress: [DEMO_LOGIN_EMAIL],
      password: DEMO_LOGIN_PASSWORD,
      firstName: "Demo",
      lastName: "Reviewer",
      skipPasswordChecks: true,
    });
  } catch (err) {
    // Another request may have created it concurrently — re-fetch before failing.
    const refetched = await clerkClient.users.getUserList({ emailAddress: [DEMO_LOGIN_EMAIL] });
    if (refetched.data[0]) return refetched.data[0];
    throw err;
  }
}

router.post("/onboarding/demo-login", async (req, res, next) => {
  try {
    const requested = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (requested !== DEMO_LOGIN_EMAIL) {
      res.status(403).json({ error: "Demo login is only available for the demo reviewer account" });
      return;
    }
    const demoUser = await ensureDemoUser();
    const token = await clerkClient.signInTokens.createSignInToken({
      userId: demoUser.id,
      expiresInSeconds: 120,
    });
    res.json({ ticket: token.token });
  } catch (err) {
    next(err);
  }
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function serializeCase(row: typeof onbCases.$inferSelect) {
  return {
    id: row.id,
    workerName: row.workerName,
    workerEmail: row.workerEmail,
    workerPhone: row.workerPhone,
    channelPreference: row.channelPreference,
    hireType: row.hireType,
    workerCategory: row.workerCategory,
    workerBand: row.workerBand,
    role: row.role,
    department: row.department,
    geography: row.geography,
    legalEntity: row.legalEntity,
    managerName: row.managerName,
    recruiterName: row.recruiterName,
    joiningDate: row.joiningDate,
    urgency: row.urgency,
    lifecycleStage: row.lifecycleStage,
    orchestrationStatus: row.orchestrationStatus,
    readiness: row.readiness,
    workstreams: row.workstreams,
    primarySkill: row.primarySkill,
    skillCriticality: row.skillCriticality,
    scenarioKey: row.scenarioKey,
    planSummary: row.planSummary,
    checklistTemplateVersion: row.checklistTemplateVersion,
    checklistSnapshot: row.checklistSnapshot,
    checklistProfileId: row.checklistProfileId,
    checklistProfileName: row.checklistProfileName,
    checklistProfileVersion: row.checklistProfileVersion ?? row.checklistTemplateVersion,
    checklistMatchedCriteria: row.checklistMatchedCriteria,
    checklistMatchExplanation: row.checklistMatchExplanation,
    orchestrationCheckpoint: row.orchestrationCheckpoint,
    candidateEmailAuthorized: Boolean(row.candidateEmailAuthorizedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeEvent(row: typeof onbEvents.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

async function insertCaseAndStart(
  values: Omit<typeof onbCases.$inferInsert, "organizationId">,
  organizationId: string,
) {
  const logisticsDefault = await getDay1LogisticsDefault(organizationId);
  const row = await db.transaction(async (tx) => {
    const profile = await resolveChecklistProfileInTransaction(tx, organizationId, {
      band: values.workerBand ?? values.workerCategory,
      role: values.role,
      employmentType: values.hireType,
      location: values.geography,
    });
    const [inserted] = await tx
      .insert(onbCases)
      .values({
        ...values,
        ...organizationValues(organizationId),
        checklistTemplateVersion: profile.templateVersion,
        checklistSnapshot: profile.items,
        checklistProfileId: profile.profileId,
        checklistProfileName: profile.profileName,
        checklistProfileVersion: profile.profileVersion,
        checklistMatchedCriteria: profile.matchedCriteria,
        checklistMatchExplanation: profile.explanation,
        readiness: readinessFromChecklist(profile.items),
        workstreams: defaultWorkstreams(),
        orchestrationStatus: "idle",
      })
      .returning();
    await tx.insert(onbCaseLogistics).values({
      organizationId,
      caseId: inserted.id,
      ...logisticsForCase(logisticsDefault, inserted.joiningDate),
    });
    return inserted;
  });
  startOrchestration(row.id);
  return row;
}

/* ----------------------------- dashboard ----------------------------- */

router.get("/onboarding/dashboard", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const cases = await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, organizationId));

    const approvalRows = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId));
    const approvals = approvalRows
      .map(({ approval }) => approval)
      .filter((approval) => approval.status === "pending");
    const recent = await db
      .select()
      .from(onbEvents)
      .where(organizationWhere(onbEvents, organizationId))
      .orderBy(desc(onbEvents.createdAt), desc(onbEvents.id))
      .limit(12);

    const byStageMap = new Map<string, number>();
    for (const c of cases) {
      byStageMap.set(c.lifecycleStage, (byStageMap.get(c.lifecycleStage) ?? 0) + 1);
    }
    const now = Date.now();
    const day1AtRisk = cases.filter((c) => {
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
      readyCases: cases.filter((c) => c.readiness.every((r) => r.status === "ready")).length,
      recentEvents: recent.map(serializeEvent),
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

router.post("/onboarding/scenarios/:key/run", async (req, res, next) => {
  try {
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
    }, getOrganizationId(req));
    res.status(201).json(serializeCase(row));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- cases ------------------------------- */

router.get("/onboarding/cases", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, getOrganizationId(req)))
      .orderBy(desc(onbCases.id));
    res.json(rows.map(serializeCase));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases", async (req, res, next) => {
  try {
    const body = CreateOnboardingCaseBody.parse(req.body);
    const workerEmail = body.workerEmail.trim().toLowerCase();
    const channelPreference = normalizePreference(body.channelPreference);
    if (!isValidEmail(workerEmail)) {
      res.status(400).json({ message: "Enter a valid candidate email address." });
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
          organizationWhere(onbCases, getOrganizationId(req)),
        ),
      );
    if (dupes.length > 0) {
      res.status(409).json({
        message: `An active onboarding case already exists for ${body.workerName} (case #${dupes[0].id}). Duplicate triggers must be reviewed by HR / Talent Acquisition.`,
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
      role: body.role,
      department: body.department,
      geography: body.geography,
      legalEntity: body.legalEntity,
      managerName: body.managerName,
      recruiterName: body.recruiterName,
      joiningDate: body.joiningDate,
      primarySkill: body.primarySkill ?? null,
      skillCriticality: body.skillCriticality ?? null,
      notes: body.notes ?? null,
      scenarioKey: null,
      candidateEmailAuthorizedAt: shouldAuthorizeCandidateEmail(workerEmail, channelPreference) ? new Date() : null,
      candidateEmailAuthorizedBy: shouldAuthorizeCandidateEmail(workerEmail, channelPreference) ? req.authUserId! : null,
    }, getOrganizationId(req));
    if (row.candidateEmailAuthorizedAt) {
      try {
        await issueCandidatePortalLink({
          organizationId: getOrganizationId(req),
          caseId: row.id,
          issuedBy: req.authUserId!,
          publicBase: portalPublicBase(req),
          sendEmail: true,
          idempotencyKey: AUTOMATED_PORTAL_EMAIL_KEY(row.id),
        });
      } catch (error) {
        console.error(`[candidate-portal] automatic provisioning failed for case ${row.id}:`, error);
      }
    }
    res.status(201).json(serializeCase(row));
  } catch (err) {
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
    res.json(serializeCase(row));
  } catch (err) {
    next(err);
  }
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
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(onbCases).where(and(
        eq(onbCases.id, id),
        organizationWhere(onbCases, organizationId),
      )).for("update");
      if (!current) return { kind: "not-found" as const };
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
      const preOrchestration =
        current.orchestrationStatus === "idle" &&
        current.lifecycleStage === "trigger-received" &&
        current.orchestrationCheckpoint === null;
      await acquireChecklistPolicyLock(tx, organizationId);
      const profile = await resolveChecklistProfileInTransaction(tx, organizationId, {
        band: current.workerBand ?? current.workerCategory,
        role: current.role,
        employmentType: current.hireType,
        location: current.geography,
      });
      const readiness = mergeChecklistReadiness(profile.items, current.readiness);
      const unchanged =
        current.checklistTemplateVersion === profile.templateVersion &&
        current.checklistProfileId === profile.profileId &&
        current.checklistProfileVersion === profile.profileVersion &&
        JSON.stringify(current.checklistSnapshot) === JSON.stringify(profile.items);
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
        : activeReplacementDecision(current, profile.items, readiness);
      if (!replacementDecision.ok) {
        return { kind: "conflict" as const, message: replacementDecision.reason };
      }
      const [row] = await tx.update(onbCases).set({
        checklistTemplateVersion: profile.templateVersion,
        checklistSnapshot: profile.items,
        checklistProfileId: profile.profileId,
        checklistProfileName: profile.profileName,
        checklistProfileVersion: profile.profileVersion,
        checklistMatchedCriteria: profile.matchedCriteria,
        checklistMatchExplanation: profile.explanation,
        readiness,
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
    });
    if (outcome.kind === "not-found") {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    if (outcome.kind === "conflict") {
      res.status(409).json({ message: outcome.message });
      return;
    }
    res.json(serializeCase(outcome.row));
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/cases/:id/checklist/:itemId", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
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
    });
    if (!result.ok) {
      const messages = {
        "not-found": "Case or checklist item not found.",
        "not-custom": "Connector-managed checklist items cannot be changed manually.",
        disabled: "Disabled checklist items cannot be changed.",
      };
      res.status(result.code === "not-custom" || result.code === "disabled" ? 409 : 404)
        .json({ message: messages[result.code] });
      return;
    }
    res.json(serializeCase(result.case));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/events", async (req, res, next) => {
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
    const rows = await db
      .select()
      .from(onbEvents)
      .where(eq(onbEvents.caseId, id))
      .orderBy(asc(onbEvents.createdAt), asc(onbEvents.id));
    res.json(rows.map(serializeEvent));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/communications", async (req, res, next) => {
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
    const rows = await db
      .select()
      .from(onbCommunications)
      .where(eq(onbCommunications.caseId, id))
      .orderBy(asc(onbCommunications.createdAt), asc(onbCommunications.id));
    res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err) {
    next(err);
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
    const reviewer = await resolveReviewerName(req.authUserId!);
    const result = await retryCandidateEmail(caseId, communicationId, reviewer);
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : result.code === "not-retryable" ? 409 : 403;
      res.status(status).json({ message: result.reason });
      return;
    }
    const row = result.communication;
    res.json({ ...row, createdAt: row.createdAt.toISOString(), retriedAt: iso(row.retriedAt) });
  } catch (err) {
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
    res.json(
      rows.map((r) => {
        const latest = latestUploads.get(r.id);
        const securityBlocked = !!latest && !malwareUploadIsClean(latest);
        const status = securityBlocked && r.status === "verified" ? "received" : r.status;
        return {
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
        };
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
    const rows = await db.select({
      id: onbCandidateUploads.id, documentId: onbCandidateUploads.documentId,
      originalName: onbCandidateUploads.originalName, contentType: onbCandidateUploads.contentType,
      sizeBytes: onbCandidateUploads.sizeBytes, checksumSha256: onbCandidateUploads.checksumSha256,
      validationState: onbCandidateUploads.validationState, validationReasons: onbCandidateUploads.validationReasons,
      validationStartedAt: onbCandidateUploads.validationStartedAt, validatedAt: onbCandidateUploads.validatedAt,
      malwareScanState: onbCandidateUploads.malwareScanState,
      malwareScannedAt: onbCandidateUploads.malwareScannedAt,
      malwareScanSha256: onbCandidateUploads.malwareScanSha256,
      label: onbDocuments.label, category: onbDocuments.category, required: onbDocuments.required,
      reminderCount: onbDocuments.reminderCount, reminderNextAt: onbDocuments.reminderNextAt,
    }).from(onbCandidateUploads).innerJoin(onbDocuments, and(eq(onbDocuments.id, onbCandidateUploads.documentId), eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId))).where(and(eq(onbCandidateUploads.caseId, caseId), eq(onbCandidateUploads.organizationId, organizationId))).orderBy(desc(onbCandidateUploads.id));
    const latestByDocument = new Map<number, typeof rows[number]>();
    for (const row of rows) if (!latestByDocument.has(row.documentId)) latestByDocument.set(row.documentId, row);
    return res.json(rows.map(({ checksumSha256, malwareScanSha256, ...row }) => {
      const isLatest = latestByDocument.get(row.documentId)?.id === row.id;
      const malwareClean = malwareUploadIsClean({ malwareScanState: row.malwareScanState, checksumSha256, malwareScanSha256 });
      return {
        ...row,
        fingerprint: checksumSha256?.slice(0, 12) ?? null,
        malwareScannedAt: iso(row.malwareScannedAt),
        malwareClean,
        isLatest,
        canReview: isLatest && ["manual_review", "correction_requested"].includes(row.validationState) && malwareClean,
        canRequestCorrection: isLatest && (
          ["manual_review", "correction_requested"].includes(row.validationState) ||
          (!malwareClean && row.validationState !== "rejected")
        ),
        canRetryScan: isLatest && malwareScanCanRetry(row.malwareScanState),
      };
    }));
  } catch (error) { return next(error); }
});

router.post("/onboarding/cases/:id/evidence/:evidenceId/decision", async (req, res, next) => {
  try {
    if (!requireHrChecklistRole(req, res)) return;
    const caseId = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    const organizationId = getOrganizationId(req);
    const body = DecideOnboardingEvidenceBody.parse(req.body);
    const decision = body.decision;
    const reason = body.reason.trim();
    const state = decision === "approve" ? "passed" : decision === "reject" ? "rejected" : "correction_requested";
    const [target] = await db.select({ documentId: onbCandidateUploads.documentId }).from(onbCandidateUploads).where(and(
      eq(onbCandidateUploads.id, evidenceId),
      eq(onbCandidateUploads.caseId, caseId),
      eq(onbCandidateUploads.organizationId, organizationId),
    ));
    if (!target) return res.status(404).json({ message: "Evidence not found" });
    const result = await db.transaction(async (tx) => {
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
    });
    if (result.kind === "not_found") return res.status(404).json({ message: "Evidence not found" });
    if (result.kind === "not_reviewable") return res.status(409).json({ message: "Evidence is not awaiting manual review." });
    if (result.kind === "stale") return res.status(409).json({ message: "Only the latest upload for this document can be used for this decision." });
    if (result.kind === "malware_blocked") return res.status(409).json({ message: "Approval is locked until the latest upload passes its security scan." });
    await reconcileDocumentationReadiness(organizationId, caseId);
    return res.json({ id: result.row.id, validationState: result.row.validationState, validationReasons: result.row.validationReasons, validatedAt: result.row.validatedAt });
  } catch (error) { return next(error); }
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
    const requeued = await requeueDocumentMalwareScan(organizationId, caseId, evidenceId);
    if (!requeued) return res.status(409).json({ message: "This security scan could not be queued again." });
    return res.json({ id: evidenceId, malwareScanState: "pending", malwareScannedAt: null, canRetryScan: false });
  } catch (error) { return next(error); }
});

router.get("/onboarding/cases/:id/bgv", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id);
    const [owned] = await db.select({ id: onbCases.id }).from(onbCases).where(and(eq(onbCases.id, caseId), organizationWhere(onbCases, getOrganizationId(req))));
    if (!owned) return res.status(404).json({ message: "Case not found" });
    const rows = await db.select({
      id: onbSystemChecks.id, system: onbSystemChecks.system, externalRef: onbSystemChecks.externalRef,
      status: onbSystemChecks.status, requestedAt: onbSystemChecks.requestedAt, dueAt: onbSystemChecks.dueAt,
      completedAt: onbSystemChecks.completedAt, note: onbSystemChecks.note,
    }).from(onbSystemChecks).where(and(eq(onbSystemChecks.caseId, caseId), eq(onbSystemChecks.organizationId, getOrganizationId(req)), eq(onbSystemChecks.system, "bgv")));
    return res.json(rows.map((row) => ({
      ...row,
      status: normalizeBgvStatus(row.status),
    })));
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
    const stints = await getArchivedStints(c.workerEmail, getOrganizationId(req));
    res.json(
      stints.map((s) => ({
        id: s.id,
        workerEmail: s.workerEmail,
        workerName: s.workerName,
        role: s.role,
        department: s.department,
        startDate: s.startDate,
        endDate: s.endDate,
        exitReason: s.exitReason,
        noticeRequiredDays: s.noticeRequiredDays,
        noticeServedDays: s.noticeServedDays,
        performanceRating: s.performanceRating,
        rehireEligible: s.rehireEligible,
        notes: s.notes,
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
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, id),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!c) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const from =
      body.channel === "whatsapp" && c.workerPhone ? c.workerPhone : c.workerEmail;
    const [row] = await db
      .insert(onbCommunications)
      .values({
        ...organizationValues(organizationId),
        caseId: id,
        channel: body.channel,
        direction: "inbound",
        toAddress: from,
        subject: null,
        body: body.body,
        status: "received",
        sensitive: false,
      })
      .returning();
    handleInbound(id, body.channel as "email" | "whatsapp", body.body);
    res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
  } catch (err) {
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
      await recordInbound({
        caseId: match.id,
        organizationId: match.organizationId,
        channel: "whatsapp",
        fromAddress: from,
        subject: null,
        body: text.slice(0, 4000),
        externalMessageId: messageSid,
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
    const { say, done } = await voiceTurn(session, speech);
    if (done) {
      await finalizeVoiceCall(session, "completed");
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
    if (session && !session.finalized) {
      await finalizeVoiceCall(session, String(req.body?.CallStatus ?? "completed"));
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
        await db
          .update(onbCommunications)
          .set({ status: finalStatus, failureReason })
          .where(and(
            eq(onbCommunications.id, candidate.id),
            organizationWhere(onbCommunications, candidate.organizationId),
          ));
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ----------------------------- approvals ----------------------------- */

router.get("/onboarding/approvals", async (req, res, next) => {
  try {
    const wantAll = req.query.status === "all";
    const rows = await db
      .select({
        approval: onbApprovals,
        workerName: onbCases.workerName,
      })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(req)))
      .orderBy(desc(onbApprovals.createdAt), desc(onbApprovals.id));
    const filtered = wantAll
      ? rows
      : rows.filter((row) => row.approval.status === "pending");
    res.json(
      filtered.map(({ approval: a, workerName }) => ({
        id: a.id,
        caseId: a.caseId,
        caseWorkerName: workerName,
        agent: a.agent,
        ruleRef: a.ruleRef,
        hitlPattern: a.hitlPattern,
        recommendation: a.recommendation,
        rationale: a.rationale,
        recordsEvidence: a.recordsEvidence,
        status: a.status,
        decidedBy: a.decidedBy,
        comment: a.comment,
        createdAt: a.createdAt.toISOString(),
        decidedAt: iso(a.decidedAt),
      })),
    );
  } catch (err) {
    next(err);
  }
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
    const decidedBy = await resolveReviewerName(req.authUserId!);
    const [updated] = await db
      .update(onbApprovals)
      .set({
        status: body.decision,
        decidedBy,
        comment: body.comment ?? null,
        decidedAt: new Date(),
      })
      .where(and(eq(onbApprovals.id, id), eq(onbApprovals.status, "pending")))
      .returning();
    if (!updated) {
      res.status(400).json({ message: "Approval already decided" });
      return;
    }
    const [c] = await db
      .select()
      .from(onbCases)
      .where(and(
        eq(onbCases.id, a.caseId),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    resumeAfterDecision({
      caseId: a.caseId,
      approved: body.decision === "approved",
      decidedBy,
      comment: body.comment ?? null,
      recommendation: a.recommendation,
      hitlPattern: a.hitlPattern,
      resumeAction: a.resumeAction ?? "none",
    });
    res.json({
      id: updated.id,
      caseId: updated.caseId,
      caseWorkerName: c?.workerName ?? "",
      agent: updated.agent,
      ruleRef: updated.ruleRef,
      hitlPattern: updated.hitlPattern,
      recommendation: updated.recommendation,
      rationale: updated.rationale,
      recordsEvidence: updated.recordsEvidence,
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
  const [systemWatcher, emailWatch, inboundEmail, approverInbox, scenarioFiles, candidateAccess] = await Promise.all([
    runSystemWatcherTick(),
    runEmailWatchTick(),
    runInboundEmailTick(),
    runApproverInboxTick(),
    runScenarioFileMaintenance(),
    runCandidateAccessCleanup(),
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
  });
};

router.get("/onboarding/webhooks/watcher-tick", watcherTick);
router.post("/onboarding/webhooks/watcher-tick", watcherTick);

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
    priority: profile.priority,
    enabled: profile.enabled,
    effectiveChecklist: applyChecklistOverrides(base.items, profile.overrides),
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
    res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
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

router.get("/onboarding/demo/volunteers", async (req, res, next) => {
  try {
    res.json({ volunteers: await loadVolunteers(getOrganizationId(req)), personas: listPersonas() });
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/demo/volunteers", async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.volunteers) ? req.body.volunteers : [];
    const volunteers = await saveVolunteers(getOrganizationId(req), raw);
    res.json({ volunteers });
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/demo/volunteers/seed", async (_req, res, next) => {
  try {
    res.json({ results: await seedVolunteerCases(getOrganizationId(_req)) });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- system watcher --------------------------- */

router.get("/onboarding/systems/watcher", async (_req, res, next) => {
  try {
    await ensureConnectorsSeeded(getOrganizationId(_req));
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json({
      connectors: getSystemWatcherHealth(),
      checks: rows.map(({ check: c, workerName }) => ({
        id: c.id,
        caseId: c.caseId,
        caseWorkerName: workerName,
        system: c.system,
        label: systemDef(c.system)?.label ?? c.system,
        mode: c.mode,
        externalRef: c.externalRef,
        status: c.status,
        requestedAt: c.requestedAt.toISOString(),
        dueAt: c.dueAt.toISOString(),
        completedAt: iso(c.completedAt),
        lastCheckedAt: iso(c.lastCheckedAt),
        escalatedAt: iso(c.escalatedAt),
        note: c.note,
      })),
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
    const status = String(req.body?.status ?? "");
    if (!Number.isInteger(caseId) || !status) {
      res.status(400).json({ message: "caseId (number) and status are required" });
      return;
    }
    const result = await handleSystemWebhook({
      system: req.params.system,
      caseId,
      status,
    });
    res.status(result.ok ? 200 : 404).json({ message: result.message });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- analytics ----------------------------- */

const SUPPRESSION_THRESHOLD = 3;

type NarrativeCacheEntry = {
  signature: string | null;
  text: string | null;
  generatingFor: string | null;
};
const narrativeCache = new Map<string, NarrativeCacheEntry>();

router.get("/onboarding/analytics", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const cases = await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, organizationId));

    const approvalRows = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId));
    const approvals = approvalRows.map(({ approval }) => approval);

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
      const suppressed =
        v.count < SUPPRESSION_THRESHOLD && v.criticality !== "standard";
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
    for (const c of cases) {
      const key = c.readiness.every((r) => r.status === "ready")
        ? "day1-ready"
        : c.lifecycleStage === "exception"
          ? "exception"
          : "in-progress";
      readinessMap.set(key, (readinessMap.get(key) ?? 0) + 1);
    }

    // Narrative generation is non-blocking: the endpoint returns chart data
    // immediately with a cached narrative (or null on first load), and kicks
    // off LLM generation in the background. The client refetches until the
    // narrative for the current data signature is ready.
    const signature = JSON.stringify({
      n: cases.length,
      skills: Array.from(skillMap.entries()).map(([s, v]) => [s, v.count, v.criticality]),
      pending: approvals.filter((a) => a.status === "pending").length,
      readiness: Array.from(readinessMap.entries()),
    });
    let narrative: string | null = null;
    const cache = narrativeCache.get(organizationId) ?? {
      signature: null,
      text: null,
      generatingFor: null,
    };
    narrativeCache.set(organizationId, cache);
    if (cases.length > 0) {
      if (cache.signature === signature) {
        narrative = cache.text;
      } else {
        narrative = cache.text;
        if (cache.generatingFor !== signature) {
          cache.generatingFor = signature;
          void llmComplete(
            "You are the intelligence layer of an autonomous HR operations platform. The data you receive covers the onboarding domain only — speak to that scope and do not claim insight into domains you have no data for. Write a 3-4 sentence executive insight for HR leadership: how much onboarding work is progressing autonomously, where human intervention is concentrated, and what deserves attention next. Only trend-level statements — never name or judge an individual. Plain text, clear enterprise language, no technical jargon.",
            `Aggregate onboarding data: ${cases.length} cases. Skill inflow: ${Array.from(skillMap.entries()).map(([s, v]) => `${s} x${v.count} (${v.criticality})`).join("; ")}. Pending human reviews: ${approvals.filter((a) => a.status === "pending").length}. Readiness: ${Array.from(readinessMap.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}. Suppression threshold: groups under ${SUPPRESSION_THRESHOLD} are not reported individually.`,
            300,
          )
            .then((text) => {
              cache.signature = signature;
              cache.text = text;
            })
            .catch((err) => {
              console.error("[analytics] narrative generation failed:", err);
            })
            .finally(() => {
              if (cache.generatingFor === signature) cache.generatingFor = null;
            });
        }
      }
    }

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
