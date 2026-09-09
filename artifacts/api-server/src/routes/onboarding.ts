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
  onbSettings,
  onbSystemChecks,
} from "@workspace/db/schema";
import {
  CreateOnboardingCaseBody,
  DecideOnboardingApprovalBody,
  ReceiveOnboardingInboundBody,
  SimulateOnboardingWatchEmailBody,
  TestOnboardingChannelBody,
  UpdateOnboardingConnectorBody,
  UpdateOnboardingSettingsBody,
} from "@workspace/api-zod";
import {
  defaultReadiness,
  defaultWorkstreams,
  handleInbound,
  resumeAfterDecision,
  startOrchestration,
} from "../lib/onboarding/engine";
import { getScenario, SCENARIOS, DEMO_EMAIL } from "../lib/onboarding/scenarios";
import { ensureConnectorsSeeded } from "../lib/onboarding/connectors";
import {
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
} from "../lib/onboarding/settings";
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
import { resolveReviewerName } from "../middlewares/require-auth";
import { clerkClient } from "@clerk/express";
import {
  getOrganizationId,
  organizationValues,
  organizationWhere,
} from "../lib/organization-scope";

const router: IRouter = Router();

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
    const token = process.env.ONB_SYSTEM_WEBHOOK_TOKEN;
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
  const [row] = await db
    .insert(onbCases)
    .values({
      ...values,
      ...organizationValues(organizationId),
      readiness: defaultReadiness(),
      workstreams: defaultWorkstreams(),
      orchestrationStatus: "running",
    })
    .returning();
  startOrchestration(row.id);
  return row;
}

    const organizationId = getOrganizationId(req);

    const organizationId = getOrganizationId(req);

    const organizationId = getOrganizationId(req);

    const organizationId = getOrganizationId(req);

    const organizationId = getOrganizationId(req);

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
    const recent = await db
      .select({ event: onbEvents })
      .from(onbEvents)
      .innerJoin(onbCases, eq(onbEvents.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId))
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
      hardBlocked: approvals.filter(
        ({ onb_approvals: approval }) => approval.hitlPattern === "hard-block",
      ).length,
      day1AtRisk,
      readyCases: cases.filter((c) => c.readiness.every((r) => r.status === "ready")).length,
      recentEvents: recent.map(({ event }) => serializeEvent(event)),
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
    const scenario = req.body?.scenario === "sla-escalation" ? "sla-escalation" : "day-before";
    if (!scenario) {
      res.status(404).json({ message: `Unknown scenario "${req.params.key}"` });
      return;
    }
    const joiningDate = new Date(
      Date.now() + scenario.intake.joiningDateOffsetDays * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const row = result.communication;
    res.status(201).json(serializeCase(row));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- cases ------------------------------- */

router.get("/onboarding/cases", async (req, res, next) => {
  try {
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(rows.map(serializeCase));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases", async (req, res, next) => {
  try {
    const body = TestOnboardingChannelBody.parse(req.body);
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
    const row = result.communication;
    res.json({ ...row, createdAt: row.createdAt.toISOString(), retriedAt: iso(row.retriedAt) });
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/documents", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(onbConnectors)
      .where(and(eq(onbConnectors.key, req.params.key), organizationWhere(onbConnectors, organizationId)));
    if (!row) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    res.json(serializeCase(row));
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
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(
      rows.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        key: r.key,
        label: r.label,
        category: r.category,
        status: r.status,
        required: r.required,
        note: r.note,
        updatedAt: r.updatedAt.toISOString(),
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/records", async (req, res, next) => {
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
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases/:id/communications/:communicationId/retry", async (req, res, next) => {
  try {
    const caseId = Number(req.body?.caseId);
    const communicationId = Number(req.params.communicationId);

    const [ownedCase] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(and(
        eq(onbCases.id, caseId),
        organizationWhere(onbCases, getOrganizationId(req)),
      ));
    const reviewer = await resolveReviewerName(req.authUserId!);
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
    if (!result.ok) {
    const status = String(req.body?.status ?? "");
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
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(
      rows.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        key: r.key,
        label: r.label,
        category: r.category,
        status: r.status,
        required: r.required,
        note: r.note,
        updatedAt: r.updatedAt.toISOString(),
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id/records", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, a.caseId),
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
    const body = TestOnboardingChannelBody.parse(req.body);
    if (body.channel !== "email" && body.channel !== "whatsapp") {
      res.status(400).json({ message: "channel must be 'email' or 'whatsapp'" });
      return;
    }
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, a.caseId),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    if (!c) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const from = String(req.body?.From ?? "").replace(/^whatsapp:/, "");
    const [row] = await db
      .select()
      .from(onbConnectors)
      .where(and(eq(onbConnectors.key, req.params.key), organizationWhere(onbConnectors, organizationId)));
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

const digitsOnly = (s: string) => s.replace(/\D/g, "");

router.post("/onboarding/webhooks/twilio/whatsapp", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN) {
      res.status(503).json({ message: "Twilio is not configured" });
      return;
    }
    if (!requestSignatureValid(req)) {
      void recordGuardrailEvent({ key: "webhook-signature", action: "rejected", detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.` });
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

    // Signed delivery still has no tenant credential. Only route a phone
    // identity when it maps to exactly one active organization.
    const cases = await db
      .select()
      .from(onbCases)
      .where(organizationWhere(onbCases, organizationId));

    const approvalRows = await db
      .select({ approval: onbApprovals })
      .from(onbApprovals)
      .innerJoin(onbCases, eq(onbApprovals.caseId, onbCases.id))
      .where(organizationWhere(onbCases, organizationId));
    const fromDigits = digitsOnly(from);

    const matches = cases.filter(
      (c) => c.workerPhone && digitsOnly(c.workerPhone) === fromDigits,
    );
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
    res.json({ status: result.status, note: result.note });
  } catch (err) {
    next(err);
  }
});

/** Twilio fetches this when the hire answers: greet + listen. */
router.post("/onboarding/webhooks/twilio/voice-answer", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN || !requestSignatureValid(req)) {
      void recordGuardrailEvent({ key: "webhook-signature", action: "rejected", detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.` });
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
      void recordGuardrailEvent({ key: "webhook-signature", action: "rejected", detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.` });
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
      void recordGuardrailEvent({ key: "webhook-signature", action: "rejected", detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.` });
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
        void recordGuardrailEvent({ key: "webhook-signature", action: "rejected", detail: `Webhook to ${req.path} failed Twilio signature validation — request discarded.` });
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
    const wantAll = req.query.status === "all";
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    const filtered = wantAll
      ? rows
      : rows.filter((r) => r.approval.status === "pending");
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
    const body = TestOnboardingChannelBody.parse(req.body);
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
    // Record the real signed-in reviewer, never a client-supplied name.
    const decidedBy = await resolveReviewerName(req.authUserId!);
    // Conditional update: only transitions from pending, so concurrent
    // decisions cannot both win and double-trigger orchestration.
    const [updated] = await db
      .update(onbConnectors)
      .set({
        vendor: body.vendor ?? row.vendor,
        status: body.status ?? row.status,
        trackingMode: body.trackingMode ?? row.trackingMode,
        lastSyncAt: new Date(),
      })
      .where(and(eq(onbConnectors.key, req.params.key), organizationWhere(onbConnectors, organizationId)))
      .returning();
    if (!updated) {
      res.status(400).json({ message: "Approval already decided" });
      return;
    }
    const [c] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, a.caseId),
      organizationWhere(onbCases, getOrganizationId(req)),
    ));
    const rows = await db
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(rows.map(serializeCase));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases", async (req, res, next) => {
  try {
    const body = TestOnboardingChannelBody.parse(req.body);
    const [row] = await db
      .select()
      .from(onbConnectors)
      .where(and(eq(onbConnectors.key, req.params.key), organizationWhere(onbConnectors, organizationId)));
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
      .where(and(eq(onbConnectors.key, req.params.key), organizationWhere(onbConnectors, organizationId)))
      .returning();
    // Retag open checks so a tracking-mode switch takes effect for
    // in-flight cases too (done checks keep their historical mode).
    if (body.trackingMode && body.trackingMode !== row.trackingMode) {
      const def = WATCHED_SYSTEMS.find((s) => s.connectorKey === req.params.key);
      if (def) {
        await db
          .update(onbSystemChecks)
          .set({
            mode: body.trackingMode === "email" ? "email" : def.mode,
          })
          .where(
            and(
              eq(onbSystemChecks.system, def.key),
              organizationWhere(onbSystemChecks, organizationId),
              sql`${onbSystemChecks.status} in ('pending', 'overdue')`,
            ),
          );
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
  const [systemWatcher, emailWatch, inboundEmail, approverInbox, scenarioFiles] = await Promise.all([
    runSystemWatcherTick(),
    runEmailWatchTick(),
    runInboundEmailTick(),
    runApproverInboxTick(),
    runScenarioFileMaintenance(),
  ]);
  res.json({
    ran: true,
    ranAt: new Date().toISOString(),
    systemWatcher,
    emailWatch,
    inboundEmail,
    approverInbox,
    scenarioFiles,
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
    const body = TestOnboardingChannelBody.parse(req.body);
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
  return {
    hrAlertEmail,
    envFallback,
    effective,
    source: hrAlertEmail ? "settings" : envFallback ? "environment" : null,
    autoEscalationCalls: await autoEscalationCallsEnabled(organizationId),
    hrApproverEmail: await getSetting(organizationId, HR_APPROVER_EMAIL_KEY),
  };
}

router.get("/onboarding/settings", async (req, res, next) => {
  try {
    res.json(await settingsPayload(getOrganizationId(req)));
  } catch (err) {
    next(err);
  }
});

router.put("/onboarding/settings", async (req, res, next) => {
  try {
    const body = TestOnboardingChannelBody.parse(req.body);
    const raw = Array.isArray(req.body?.volunteers) ? req.body.volunteers : [];
      if (raw.length === 0) {
        await setSetting(organizationId, HR_ALERT_EMAIL_KEY, null);
      } else {
        if (!isValidEmail(raw)) {
          res.status(400).json({ error: "Enter a valid email address (e.g. hr@company.com)." });
          return;
        }
        await setSetting(organizationId, HR_ALERT_EMAIL_KEY, raw);
      }
    }
    if (body.autoEscalationCalls !== undefined) {
      await setSetting(organizationId, AUTO_ESCALATION_CALLS_KEY, body.autoEscalationCalls ? "on" : null);
    }
    if (body.hrApproverEmail !== undefined) {
    const raw = Array.isArray(req.body?.volunteers) ? req.body.volunteers : [];
      if (raw.length === 0) {
        await setSetting(organizationId, HR_APPROVER_EMAIL_KEY, null);
      } else {
        if (!isValidEmail(raw)) {
          res.status(400).json({ error: "Enter a valid email address for the HR approver." });
          return;
        }
        await setSetting(organizationId, HR_APPROVER_EMAIL_KEY, raw);
      }
      // The approver address doubles as a live-delivery authorization —
      // apply the change to the in-process allowlist immediately.
      await refreshDemoAllowlist(organizationId);
    }
    res.json(await settingsPayload(organizationId));
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- guardrails ----------------------------- */

router.get("/onboarding/guardrails", async (req, res, next) => {
  try {
    const counts = await db
      .select({
        key: onbGuardrailEvents.guardrailKey,
        count: sql<number>`count(*)::int`,
        lastAt: sql<string | null>`max(${onbGuardrailEvents.createdAt})`,
      })
      .from(onbGuardrailEvents)
      .innerJoin(onbCases, eq(onbGuardrailEvents.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(req)))
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
      .select({ check: onbSystemChecks, workerName: onbCases.workerName })
      .from(onbSystemChecks)
      .innerJoin(onbCases, eq(onbSystemChecks.caseId, onbCases.id))
      .where(organizationWhere(onbCases, getOrganizationId(_req)))
      .orderBy(desc(onbSystemChecks.id));
    res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err) {
    next(err);
  }
});

const lastDrillAt = new Map<string, number>();
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
