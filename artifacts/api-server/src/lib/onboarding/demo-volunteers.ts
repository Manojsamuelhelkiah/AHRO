/**
 * Demo volunteers: an admin-managed list of real people (name/email/phone)
 * used to run live demos. Stored in the onb_settings key/value table so it
 * can be edited from the control tower UI per audience.
 *
 * Saving the list also refreshes the runtime delivery allowlist, so real
 * emails, WhatsApp messages and voice calls can reach exactly these people
 * (plus anyone in ONBOARDING_ALLOWED_RECIPIENTS) and nobody else.
 */
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbCases } from "@workspace/db/schema";
import { and, sql } from "drizzle-orm";
import { getSetting, setSetting, isValidEmail, HR_APPROVER_EMAIL_KEY } from "./settings";
import { setDemoAllowlist } from "./channels";
import { defaultWorkstreams, startOrchestration } from "./engine";
import { getEffectiveChecklist, readinessFromChecklist } from "./settings";
import { SCENARIOS, getScenario } from "./scenarios";
import { organizationValues, organizationWhere } from "../organization-scope";

export const DEMO_VOLUNTEERS_KEY = "demo_volunteers";

export type DemoVolunteer = {
  name: string;
  email: string;
  phone: string;
  channelPreference: string;
  /** Scenario key from scenarios.ts, or "custom" for a plain case. */
  persona: string;
  role: string;
  department: string;
  geography: string;
  hireType: string;
  workerCategory: string;
  managerName: string;
  recruiterName: string;
  joiningDate: string;
  notes: string;
};

const CHANNELS = ["email", "whatsapp", "both"];

/** Coerce any client-supplied value to a bounded trimmed string (never throws). */
function str(value: unknown, fallback: string, max: number): string {
  return (typeof value === "string" ? value : fallback).trim().slice(0, max);
}

export function normalizeVolunteer(raw: Partial<DemoVolunteer>): DemoVolunteer {
  const joiningDate = str(raw.joiningDate, "", 10);
  return {
    name: str(raw.name, "", 120),
    email: str(raw.email, "", 200),
    phone: str(raw.phone, "", 25).replace(/[\s-]/g, "").slice(0, 20),
    channelPreference: CHANNELS.includes(str(raw.channelPreference, "", 20)) ? (raw.channelPreference as string) : "email",
    persona: getScenario(str(raw.persona, "", 40)) ? (raw.persona as string) : "custom",
    role: str(raw.role, "Software Engineer", 120),
    department: str(raw.department, "Engineering", 120),
    geography: str(raw.geography, "India", 60),
    hireType: str(raw.hireType, "external", 30),
    workerCategory: str(raw.workerCategory, "full-time", 30),
    managerName: str(raw.managerName, "Demo Manager", 120) || "Demo Manager",
    recruiterName: str(raw.recruiterName, "Demo Recruiter", 120) || "Demo Recruiter",
    joiningDate: /^\d{4}-\d{2}-\d{2}$/.test(joiningDate)
      ? joiningDate
      : new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
    notes: str(raw.notes, "Demo volunteer", 300),
  };
}

export function volunteerProblems(v: DemoVolunteer): string | null {
  if (!v.name) return "Name is required";
  if (!/^\S+@\S+\.\S+$/.test(v.email)) return "Enter a valid email address";
  if (v.phone && !/^\+\d{8,15}$/.test(v.phone)) return "Phone must be international format, e.g. +919876543210";
  if ((v.channelPreference === "whatsapp" || v.channelPreference === "both") && !v.phone)
    return "WhatsApp needs a phone number";
  return null;
}

export async function loadVolunteers(organizationId: string): Promise<DemoVolunteer[]> {
  const raw = await getSetting(organizationId, DEMO_VOLUNTEERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeVolunteer) : [];
  } catch {
    return [];
  }
}

export async function saveVolunteers(organizationId: string, raw: Partial<DemoVolunteer>[]): Promise<DemoVolunteer[]> {
  const volunteers = raw.slice(0, 20).map(normalizeVolunteer);
  await setSetting(organizationId, DEMO_VOLUNTEERS_KEY, JSON.stringify(volunteers));
  await initDemoAllowlist(organizationId);
  return volunteers;
}

/**
 * Refresh the in-memory allowlist from the database. Called at startup and
 * again right before any live send/call, so a save (or revocation) made on
 * another process instance takes effect immediately rather than after a
 * restart.
 *
 * The allowlist is composed of the valid demo volunteers plus the optional
 * remote HR approver address — saving that address in Settings is the
 * explicit, audited act that authorizes live delivery to it, and clearing
 * it revokes that authorization.
 */
export async function initDemoAllowlist(organizationId: string): Promise<void> {
  const addresses: string[] = [];
  for (const v of await loadVolunteers(organizationId)) {
    if (volunteerProblems(v)) continue; // only valid rows get live delivery
    addresses.push(v.email);
    if (v.phone) addresses.push(v.phone);
  }
  const approver = (await getSetting(organizationId, HR_APPROVER_EMAIL_KEY))?.trim();
  if (approver && isValidEmail(approver)) addresses.push(approver);
  setDemoAllowlist(organizationId, addresses);
}
export const refreshDemoAllowlist = initDemoAllowlist;

export type PersonaInfo = {
  key: string;
  title: string;
  description: string;
  expectedBehaviour: string;
  volunteerBrief: string;
};

/** What each persona should do on the receiving end, in plain words. */
const PERSONA_BRIEFS: Record<string, string> = {
  "standard-fte":
    "The smooth hire. You'll get a welcome email with a document checklist. Reply to any email with questions ('did you get my documents?', 'what's still pending?') — the agent answers from your actual case. When offered kick-off call times, reply 'option 2' to book one. The day before joining, expect the confirmation phone call.",
  "contractor-client":
    "The contractor. Your document pack is different (statement of work instead of an offer letter) — ask about it by email and check the agent knows the difference. Limited-term access is part of your story; ask what happens after the contract ends.",
  rehire:
    "The returning employee. Your record partially exists, so ask things like 'do you still have my old documents?' and watch whether the agent handles you differently from a brand-new hire.",
  "internal-transfer":
    "The internal move. No background check should be requested from you — if any message asks for one, that's a catch worth showing. Ask about what changes vs stays the same in your transfer.",
  "bgv-exception":
    "The tricky one. Your background check has an exception, so expect the agent to escalate to a human instead of deciding alone. Mention a problem with a previous employer document and watch the escalation appear in the approvals queue.",
  "critical-skill":
    "The VIP hire. Your role is business-critical, so expect faster chasing and priority treatment. Go quiet on purpose for a while — the SLA escalation (and if enabled, the escalation phone call) is your showcase moment.",
  custom:
    "Free play. A standard case with your details — reply to emails, ask about documents, book a call slot with 'option 2', or go silent to trigger escalation.",
};

export function listPersonas(): PersonaInfo[] {
  return [
    ...SCENARIOS.map((s) => ({
      key: s.key,
      title: s.title,
      description: s.description,
      expectedBehaviour: s.expectedBehaviour,
      volunteerBrief: PERSONA_BRIEFS[s.key] ?? PERSONA_BRIEFS.custom,
    })),
    {
      key: "custom",
      title: "Custom (no persona)",
      description: "A plain onboarding case using exactly the details entered here.",
      expectedBehaviour: "Standard onboarding flow with no scenario-specific twists.",
      volunteerBrief: PERSONA_BRIEFS.custom,
    },
  ];
}

export type SeedResult = { name: string; status: "seeded" | "skipped" | "invalid"; note: string; caseId: number | null };

/** Create a full onboarding case (real agent pipeline) per valid volunteer. */
export async function seedVolunteerCases(
  organizationId = DEMO_ORGANIZATION_ID,
): Promise<SeedResult[]> {
  const volunteers = await loadVolunteers(organizationId);
  const checklist = await getEffectiveChecklist(organizationId);
  const results: SeedResult[] = [];
  for (const v of volunteers) {
    const problem = volunteerProblems(v);
    if (problem) {
      results.push({ name: v.name || "(unnamed)", status: "invalid", note: problem, caseId: null });
      continue;
    }
    const [dupe] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(
        and(
          sql`lower(${onbCases.workerName}) = ${v.name.toLowerCase()}`,
          sql`${onbCases.lifecycleStage} not in ('complete')`,
          organizationWhere(onbCases, organizationId),
        ),
      );
    if (dupe) {
      results.push({ name: v.name, status: "skipped", note: `Already has an active case (#${dupe.id})`, caseId: dupe.id });
      continue;
    }
    // A persona borrows the scenario's professional profile (role, category,
    // skill, notes) while keeping the volunteer's real identity and contacts,
    // so the agent's messages match the story the volunteer is playing.
    const scenario = getScenario(v.persona);
    const [row] = await db
      .insert(onbCases)
      .values({
        workerName: v.name,
        workerEmail: v.email,
        workerPhone: v.phone || null,
        channelPreference: v.phone ? v.channelPreference : "email",
        hireType: scenario?.intake.hireType ?? v.hireType,
        workerCategory: scenario?.intake.workerCategory ?? v.workerCategory,
        role: scenario?.intake.role ?? v.role,
        department: scenario?.intake.department ?? v.department,
        geography: v.geography,
        legalEntity: scenario?.intake.legalEntity ?? "Demo Legal Entity",
        managerName: v.managerName,
        recruiterName: v.recruiterName,
        joiningDate: v.joiningDate,
        primarySkill: scenario?.intake.primarySkill ?? null,
        skillCriticality: scenario?.intake.skillCriticality ?? null,
        notes: scenario?.intake.notes ?? v.notes,
        scenarioKey: scenario?.key ?? null,
        checklistTemplateVersion: checklist.version,
        checklistSnapshot: checklist.items,
        readiness: readinessFromChecklist(checklist.items),
        workstreams: defaultWorkstreams(),
        orchestrationStatus: "idle",
         ...organizationValues(organizationId),
      })
      .returning();
    startOrchestration(row.id);
    results.push({
      name: v.name,
      status: "seeded",
      note: scenario
        ? `Case created as "${scenario.title}" — agent pipeline running`
        : "Case created — agent pipeline running",
      caseId: row.id,
    });
  }
  return results;
}
