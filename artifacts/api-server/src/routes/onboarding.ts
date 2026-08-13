import { Router, type IRouter } from "express";
import { and, desc, asc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbApprovals,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbEvents,
} from "@workspace/db/schema";
import {
  CreateOnboardingCaseBody,
  DecideOnboardingApprovalBody,
  ReceiveOnboardingInboundBody,
  TestOnboardingChannelBody,
  UpdateOnboardingConnectorBody,
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
  whatsappChannelInfo,
} from "../lib/onboarding/channels";
import { llmComplete } from "../lib/onboarding/llm";
import {
  getInboundEmailMonitorStatus,
  recordInbound,
} from "../lib/onboarding/inbound-email";
import { twilioSignatureValid } from "../lib/onboarding/twilio-signature";
import { normalizePreference } from "../lib/onboarding/channel-routing";
import { requireAuth, resolveReviewerName } from "../middlewares/require-auth";

const router: IRouter = Router();

// All onboarding endpoints expose employee PII and can trigger real
// email/WhatsApp sends — every route requires a signed-in user.
// The Twilio webhook is the one exception: it is called server-to-server
// by Twilio and authenticated by its request signature instead.
router.use("/onboarding", (req, res, next) => {
  if (req.path.startsWith("/webhooks/")) {
    next();
    return;
  }
  requireAuth(req, res, next);
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeEvent(row: typeof onbEvents.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

async function insertCaseAndStart(values: typeof onbCases.$inferInsert) {
  const [row] = await db
    .insert(onbCases)
    .values({
      ...values,
      readiness: defaultReadiness(),
      workstreams: defaultWorkstreams(),
      orchestrationStatus: "running",
    })
    .returning();
  startOrchestration(row.id);
  return row;
}

/* ----------------------------- dashboard ----------------------------- */

router.get("/onboarding/dashboard", async (_req, res, next) => {
  try {
    const cases = await db.select().from(onbCases);
    const approvals = await db
      .select()
      .from(onbApprovals)
      .where(eq(onbApprovals.status, "pending"));
    const recent = await db
      .select()
      .from(onbEvents)
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
      hardBlocked: approvals.filter((a) => a.hitlPattern === "hard-block").length,
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
    });
    res.status(201).json(serializeCase(row));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- cases ------------------------------- */

router.get("/onboarding/cases", async (_req, res, next) => {
  try {
    const rows = await db.select().from(onbCases).orderBy(desc(onbCases.id));
    res.json(rows.map(serializeCase));
  } catch (err) {
    next(err);
  }
});

router.post("/onboarding/cases", async (req, res, next) => {
  try {
    const body = CreateOnboardingCaseBody.parse(req.body);
    // Duplicate-trigger prevention (spec §1.3): same person with an active case.
    const dupes = await db
      .select({ id: onbCases.id, stage: onbCases.lifecycleStage })
      .from(onbCases)
      .where(
        and(
          sql`lower(${onbCases.workerName}) = ${body.workerName.toLowerCase()}`,
          sql`${onbCases.lifecycleStage} not in ('complete')`,
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
      workerEmail: body.workerEmail,
      workerPhone: body.workerPhone ?? null,
      channelPreference: normalizePreference(body.channelPreference),
      hireType: body.hireType,
      workerCategory: body.workerCategory,
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
    });
    res.status(201).json(serializeCase(row));
  } catch (err) {
    next(err);
  }
});

router.get("/onboarding/cases/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select().from(onbCases).where(eq(onbCases.id, id));
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
    const [exists] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(eq(onbCases.id, id));
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
    const [exists] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(eq(onbCases.id, id));
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

router.post("/onboarding/cases/:id/inbound", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = ReceiveOnboardingInboundBody.parse(req.body);
    if (body.channel !== "email" && body.channel !== "whatsapp") {
      res.status(400).json({ message: "channel must be 'email' or 'whatsapp'" });
      return;
    }
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, id));
    if (!c) {
      res.status(404).json({ message: "Case not found" });
      return;
    }
    const from =
      body.channel === "whatsapp" && c.workerPhone ? c.workerPhone : c.workerEmail;
    const [row] = await db
      .insert(onbCommunications)
      .values({
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

const digitsOnly = (s: string) => s.replace(/\D/g, "");

router.post("/onboarding/webhooks/twilio/whatsapp", async (req, res, next) => {
  try {
    if (!process.env.TWILIO_AUTH_TOKEN) {
      res.status(503).json({ message: "Twilio is not configured" });
      return;
    }
    if (!requestSignatureValid(req)) {
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

    // Match the sender's phone to the most recent active case.
    const cases = await db
      .select({ id: onbCases.id, workerPhone: onbCases.workerPhone })
      .from(onbCases)
      .where(sql`${onbCases.lifecycleStage} not in ('complete')`)
      .orderBy(desc(onbCases.id));
    const fromDigits = digitsOnly(from);
    const match = cases.find(
      (c) => c.workerPhone && digitsOnly(c.workerPhone) === fromDigits,
    );
    if (match) {
      await recordInbound({
        caseId: match.id,
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
      .orderBy(desc(onbApprovals.createdAt), desc(onbApprovals.id));
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
    const [a] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, id));
    if (!a) {
      res.status(404).json({ message: "Approval not found" });
      return;
    }
    // Record the real signed-in reviewer, never a client-supplied name.
    const decidedBy = await resolveReviewerName(req.authUserId!);
    // Conditional update: only transitions from pending, so concurrent
    // decisions cannot both win and double-trigger orchestration.
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
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, a.caseId));
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

router.get("/onboarding/connectors", async (_req, res, next) => {
  try {
    await ensureConnectorsSeeded();
    const rows = await db.select().from(onbConnectors);
    res.json(rows.map((r) => ({ ...r, lastSyncAt: iso(r.lastSyncAt) })));
  } catch (err) {
    next(err);
  }
});

router.patch("/onboarding/connectors/:key", async (req, res, next) => {
  try {
    await ensureConnectorsSeeded();
    const body = UpdateOnboardingConnectorBody.parse(req.body);
    const [row] = await db
      .select()
      .from(onbConnectors)
      .where(eq(onbConnectors.key, req.params.key));
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
        lastSyncAt: new Date(),
      })
      .where(eq(onbConnectors.key, req.params.key))
      .returning();
    res.json({ ...updated, lastSyncAt: iso(updated.lastSyncAt) });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- analytics ----------------------------- */

const SUPPRESSION_THRESHOLD = 3;

router.get("/onboarding/analytics", async (_req, res, next) => {
  try {
    const cases = await db.select().from(onbCases);
    const approvals = await db.select().from(onbApprovals);

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

    let narrative: string | null = null;
    if (cases.length > 0) {
      narrative = await llmComplete(
        "You are the Data & Analytics Agent for an onboarding system. Write a 3-4 sentence aggregated workforce-planning insight for HR leadership. Only trend-level statements — never name or judge an individual. Plain text.",
        `Aggregate onboarding data: ${cases.length} cases. Skill inflow: ${Array.from(skillMap.entries()).map(([s, v]) => `${s} x${v.count} (${v.criticality})`).join("; ")}. Pending human reviews: ${approvals.filter((a) => a.status === "pending").length}. Readiness: ${Array.from(readinessMap.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}. Suppression threshold: groups under ${SUPPRESSION_THRESHOLD} are not reported individually.`,
        300,
      );
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

router.get("/onboarding/channels", (_req, res) => {
  res.json({
    email: emailChannelInfo(),
    whatsapp: whatsappChannelInfo(),
    inboundEmail: getInboundEmailMonitorStatus(),
  });
});

router.post("/onboarding/channels/test", async (req, res, next) => {
  try {
    const body = TestOnboardingChannelBody.parse(req.body);
    if (body.channel !== "email" && body.channel !== "whatsapp") {
      res.status(200).json({ ok: false, detail: "channel must be 'email' or 'whatsapp'" });
      return;
    }
    // Find (or create) a system case to attach the test message to.
    const [anyCase] = await db.select().from(onbCases).orderBy(desc(onbCases.id)).limit(1);
    if (!anyCase) {
      res.json({ ok: false, detail: "Run a scenario first so there is a case to attach the test message to." });
      return;
    }
    const info = body.channel === "email" ? emailChannelInfo() : whatsappChannelInfo();
    const to =
      body.channel === "email" ? anyCase.workerEmail : anyCase.workerPhone ?? "";
    if (body.channel === "whatsapp" && !to) {
      res.json({ ok: false, detail: "No case has a WhatsApp phone number yet — add one via the intake form." });
      return;
    }
    const result = await sendOutbound({
      caseId: anyCase.id,
      channel: body.channel,
      toAddress: to,
      subject: body.channel === "email" ? "Onboarding channel test" : null,
      body: `This is a test message from the Onboarding Agent Control Tower (${new Date().toISOString()}).`,
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
