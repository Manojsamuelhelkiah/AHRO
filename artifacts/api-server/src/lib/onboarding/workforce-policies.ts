import type {
  OnbChecklistItemOverride,
  OnbChecklistProfileCriteria,
  OnbChecklistTemplateItem,
  OnbWorkforceClassification,
  OnbWorkforceContext,
} from "@workspace/db/schema";

export type WorkforceTemplateKey = "office-lateral" | "frontline-site" | "mixed-work";

export type WorkforceStarterTemplate = {
  key: WorkforceTemplateKey;
  name: string;
  reviewed: "expert-authored-starter";
  description: string;
  criteria: OnbChecklistProfileCriteria;
  overrides: OnbChecklistItemOverride[];
  processPolicy: Record<string, unknown>;
};

/** Stable authority IDs accept human-friendly labels but never trust raw text. */
export function canonicalAuthorityRoleId(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized) ? normalized : null;
}

/** Explicit, non-site scope. It is never a wildcard for a site-bound task. */
export const ORGANIZATION_WORKFORCE_AUTHORITY_SCOPE = "__organization__";

/**
 * A site is mandatory whenever one is known.  A non-site scope is permitted
 * only after the context positively establishes office/remote work with no
 * site exposure or safety-critical duties; incomplete or hazardous facts
 * deliberately return null so callers fail closed.
 */
export function workforceAuthorityScope(
  context: OnbWorkforceContext | null | undefined,
): string | null {
  const site = context?.site?.trim();
  if (site) return site;
  const knownNonSite = (context?.workEnvironment === "office" || context?.workEnvironment === "remote") &&
    context.siteExposure === false &&
    context.safetyCritical === false &&
    (context.hazards?.length ?? 0) === 0;
  return knownNonSite ? ORGANIZATION_WORKFORCE_AUTHORITY_SCOPE : null;
}

const humanGate = (
  id: string,
  label: string,
  order: number,
  responsibleRole: string,
): OnbChecklistItemOverride => ({
  id,
  label,
  order,
  enabled: true,
  mandatory: true,
  // Safety and fitness must be verified before any workstream can issue a
  // badge, access, tools, or other deployment-adjacent effect.
  enforcementStage: "before-workstreams",
  evidenceRequired: true,
  responsibleRole,
  completionAuthority: "designated-human",
  executor: "human-task",
});

/**
 * Starter guidance is deliberately operational, not legal advice. It only
 * adds gates; it never disables a tenant's existing mandatory baseline.
 */
export const WORKFORCE_STARTER_TEMPLATES: WorkforceStarterTemplate[] = [
  {
    key: "office-lateral",
    name: "Office / lateral onboarding",
    reviewed: "expert-authored-starter",
    description: "Individual self-service intake, laptop/access provisioning, salary payroll prerequisites, manager ownership and office induction.",
    criteria: { workEnvironment: "office" },
    overrides: [
      humanGate("office-identity-review", "Identity and lawful verification review", 7, "hr"),
      humanGate("office-access-owner-confirmation", "Manager confirms laptop and application access need", 8, "hiring-manager"),
    ],
    processPolicy: {
      intake: { mode: "individual", channel: "self-upload", assistedIntakeAllowed: true },
      ownership: "hiring-manager",
      payroll: { payBasis: "salary", prerequisite: "confirmed-payroll-details" },
      induction: "office",
      executors: { laptopAccess: "human-task", unsupported: "human-task" },
      legal: "Configure checks only when lawful, applicable and approved for the jurisdiction and contract.",
    },
  },
  {
    key: "frontline-site",
    name: "Frontline / hazardous-site onboarding",
    reviewed: "expert-authored-starter",
    description: "Assisted or batch-capable intake, badge/PPE/tools coordination, wage/timesheet prerequisites, supervisor ownership and HSE/site induction.",
    criteria: { workEnvironment: "site" },
    overrides: [
      humanGate("frontline-identity-skill-review", "Identity, required license and skill evidence review", 7, "operations"),
      humanGate("medical-fitness-clearance", "Medical fitness clearance recorded by designated authority", 8, "occupational-health"),
      humanGate("safety-sign-off", "Independent site safety sign-off recorded by designated authority", 9, "hse"),
      humanGate("safety-competency", "Safety competency evidenced before floor or site access", 10, "hse"),
      humanGate("badge-ppe-tools-release", "Supervisor confirms badge, PPE and tools release prerequisites", 11, "operations"),
    ],
    processPolicy: {
      match: { operator: "all", rules: [{ field: "safetyCritical", values: ["true"] }] },
      intake: { mode: "individual-or-batch", channel: "assisted-or-self-upload" },
      ownership: "supervisor",
      payroll: { payBasis: "wage", prerequisite: "timesheet-and-payroll-details" },
      induction: "hse-site",
      deployment: {
        independentHardGates: ["medical-fitness-clearance", "safety-sign-off", "safety-competency"],
        noSubstitutes: ["readiness-score", "manual-call", "reminder", "agent-assertion", "missing-provider"],
      },
      executors: { badgePpeTools: "human-task", payroll: "human-task" },
      legal: "Medical, police and drug checks require lawful, proportionate, contract- and jurisdiction-approved applicability. India PF/UAN, ESIC, minimum-wage and overtime rules must be reviewed per contract and jurisdiction.",
    },
  },
  {
    key: "mixed-work",
    name: "Mixed work onboarding",
    reviewed: "expert-authored-starter",
    description: "Context review for roles spanning office and site work; maintains distinct safety and access evidence rather than averaging them.",
    criteria: { workEnvironment: "mixed" },
    overrides: [
      humanGate("mixed-context-review", "Manager and HSE confirm applicable office and site obligations", 7, "hse"),
      humanGate("mixed-safety-competency", "Safety competency evidenced before any site access", 8, "hse"),
    ],
    processPolicy: {
      intake: { mode: "individual-or-batch", channel: "self-upload-or-assisted" },
      ownership: "manager-and-supervisor",
      induction: "office-and-site-as-applicable",
      executors: { unsupported: "human-task" },
      legal: "Review applicable jurisdiction, contract and site requirements before publication.",
    },
  },
];

const labelFor = (label: OnbWorkforceClassification["label"]) => ({
  "white-collar": "White-collar",
  "blue-collar-frontline": "Blue-collar/frontline",
  mixed: "Mixed",
  "needs-review": "Needs review",
})[label];

/** Conservative, deterministic classification based only on the job context. */
export function classifyWorkforceContext(
  context: OnbWorkforceContext | null | undefined,
): OnbWorkforceClassification | null {
  if (!context || Object.keys(context).length === 0) return null;
  const environment = context.workEnvironment;
  const site = Boolean(context.siteExposure || context.safetyCritical || (context.hazards?.length ?? 0) > 0);
  // A work environment alone does not establish that there is no site or
  // safety exposure. Missing applicability must be reviewed, not optimized
  // into an easier route.
  const safetyScopeKnown = context.siteExposure !== undefined && context.safetyCritical !== undefined;
  const office = (environment === "office" || environment === "remote") && safetyScopeKnown;
  const frontline = environment === "site" || environment === "field" || site;
  const label = office && frontline
    ? "mixed"
    : frontline
      ? "blue-collar-frontline"
      : office
        ? "white-collar"
        : "needs-review";
  const confidence: OnbWorkforceClassification["confidence"] =
    label === "needs-review" ? "uncertain" : environment || site ? "high" : "medium";
  const rationale = label === "needs-review"
    ? "Work environment and site-exposure facts are incomplete; a job-context review is required."
    : `${labelFor(label)} indicator derived from explicit ${[
      environment ? `work environment "${environment}"` : null,
      context.siteExposure ? "site exposure" : null,
      context.safetyCritical ? "safety-critical work" : null,
      (context.hazards?.length ?? 0) ? "recorded hazards" : null,
    ].filter(Boolean).join(", ")}. It describes the job, not the person.`;
  return { label, source: "deterministic-job-context", rationale, confidence };
}

export function normalizedWorkforceContext(input: OnbWorkforceContext | undefined): OnbWorkforceContext {
  const cleanText = (value: string | undefined) => value?.trim() || undefined;
  return {
    ...input,
    roleFamily: cleanText(input?.roleFamily),
    band: cleanText(input?.band),
    department: cleanText(input?.department),
    legalEntity: cleanText(input?.legalEntity),
    businessUnit: cleanText(input?.businessUnit),
    industry: cleanText(input?.industry),
    workCountry: cleanText(input?.workCountry),
    workState: cleanText(input?.workState),
    site: cleanText(input?.site),
    employmentArrangement: cleanText(input?.employmentArrangement),
    workerCategory: cleanText(input?.workerCategory),
    payBasis: cleanText(input?.payBasis),
    shiftPattern: cleanText(input?.shiftPattern),
    accessibilityNeeds: cleanText(input?.accessibilityNeeds),
    languagePreference: cleanText(input?.languagePreference),
    batchId: cleanText(input?.batchId),
    hazards: input?.hazards?.map((value) => value.trim()).filter(Boolean),
    requiredLicenses: input?.requiredLicenses?.map((value) => value.trim()).filter(Boolean),
  };
}

export function starterTemplate(key: WorkforceTemplateKey): WorkforceStarterTemplate {
  const template = WORKFORCE_STARTER_TEMPLATES.find((candidate) => candidate.key === key);
  if (!template) throw new Error("Unknown workforce starter template.");
  return structuredClone(template);
}

/** Fail closed when the job's safety applicability has not been established. */
export function enforceContextReviewGate(
  items: readonly OnbChecklistTemplateItem[],
  classification: OnbWorkforceClassification | null,
): OnbChecklistTemplateItem[] {
  if (classification && classification.label !== "needs-review") return items.map((item) => ({ ...item }));
  if (items.some((item) => item.id === "workforce-context-review")) return items.map((item) => ({ ...item }));
  return [...items.map((item) => ({ ...item })), {
    id: "workforce-context-review",
    label: "Human review confirms work environment and safety applicability",
    order: items.length,
    enabled: true,
    mandatory: true,
    enforcementStage: "before-workstreams",
    responsibleRole: "hr",
    completionAuthority: "designated-human",
    executor: "human-task",
  }];
}