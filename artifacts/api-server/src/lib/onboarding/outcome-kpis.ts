/**
 * Calculation rules for the onboarding outcome KPI contract.
 *
 * This module deliberately contains no database or HTTP code. Evidence that
 * is not recorded in the onboarding schema is represented as
 * `not-collected`, never inferred from a current live state or a demo event.
 */

export const OUTCOME_PERIODS = ["7", "30", "90", "All"] as const;
export type OutcomePeriod = (typeof OUTCOME_PERIODS)[number];
export type OutcomeDomain = "Onboarding" | "All domains";

export type OutcomeKpiStatus =
  | "met"
  | "missed"
  | "insufficient-data"
  | "not-collected";

export type OutcomeKpi = {
  id: string;
  label: string;
  definition: string;
  baseline: string;
  targetLabel: string;
  targetValue: number;
  direction: "at-most" | "at-least";
  unit: "days" | "percent" | "score";
  value: number | null;
  status: OutcomeKpiStatus;
  sampleSize: number;
  eligibleCount: number;
  unknownCount: number;
  note: string;
};

export type OutcomeCase = {
  id: number;
  createdAt: Date;
  geography?: string | null;
  hireType?: string | null;
  scenarioKey?: string | null;
  lifecycleStage?: string | null;
  gateCApprovalStatus?: string | null;
  offerAcceptanceComplete?: boolean;
  offerAcceptanceCompletedAt?: Date | null;
};

export type OutcomeEvent = {
  caseId: number | null;
  agent: string;
  title: string;
  detail?: string | null;
  createdAt: Date;
  id?: number;
};

export type OutcomeBgvCheck = {
  id: number;
  caseId: number;
  system: string;
  mode: string;
  status: string;
  requestedAt: Date;
  completedAt?: Date | null;
};

export type OutcomeBgvEmail = {
  checkId: number | null;
  caseId: number | null;
  gmailMessageId: string;
  parsedStatus: string;
  receivedAt: Date;
};

export type OutcomeKpiResponse = {
  asOf: string;
  cohortLabel: string;
  caseCount: number;
  metrics: OutcomeKpi[];
};

export type CalculateOutcomeKpisInput = {
  cases: readonly OutcomeCase[];
  events?: readonly OutcomeEvent[];
  bgvChecks?: readonly OutcomeBgvCheck[];
  bgvEmails?: readonly OutcomeBgvEmail[];
  asOf: Date;
  period?: OutcomePeriod;
  region?: string;
  hireType?: string;
  domain?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE = "TBD";
const NEW_HIRE_TYPES = new Set(["external-fte", "rehire"]);
const AGENT_FILTER_NOTE =
  "Eligible outcome metrics use external-fte and rehire cases only; internal-transfer and contractor cases are excluded. Agent filtering is intentionally not applied; this KPI uses case-scoped evidence.";

const KPI_DEFINITIONS = {
  cycleTime: {
    id: "cycle-time",
    label: "Onboarding Cycle Time",
    definition: "Days from offer acceptance to Day-1 readiness",
    targetLabel: "≤ 7 days",
    targetValue: 7,
    direction: "at-most" as const,
    unit: "days" as const,
  },
  day1Readiness: {
    id: "day1-readiness",
    label: "Day-1 Readiness Rate",
    definition: "% of joiners fully ready on Day-1",
    targetLabel: "≥ 98%",
    targetValue: 98,
    direction: "at-least" as const,
    unit: "percent" as const,
  },
  documentCompleteness: {
    id: "doc-completeness",
    label: "Document Completeness at Intake",
    definition: "% of packages complete at first submission",
    targetLabel: "≥ 90%",
    targetValue: 90,
    direction: "at-least" as const,
    unit: "percent" as const,
  },
  bgvTurnaround: {
    id: "bgv-turnaround",
    label: "BGV Turnaround",
    definition: "Days from initiation to result",
    targetLabel: "≤ 5 days",
    targetValue: 5,
    direction: "at-most" as const,
    unit: "days" as const,
  },
  provisioningOnTime: {
    id: "provisioning-on-time",
    label: "Provisioning On-Time Rate",
    definition: "% of IT/asset requests ready by J-2",
    targetLabel: "≥ 95%",
    targetValue: 95,
    direction: "at-least" as const,
    unit: "percent" as const,
  },
  experience: {
    id: "enps",
    label: "New-Hire Experience (eNPS)",
    definition: "30-day onboarding experience score",
    targetLabel: "≥ +40",
    targetValue: 40,
    direction: "at-least" as const,
    unit: "score" as const,
  },
  attrition: {
    id: "attrition",
    label: "0–90 Day Attrition",
    definition: "% of new hires exiting within 90 days",
    targetLabel: "≤ 3%",
    targetValue: 3,
    direction: "at-most" as const,
    unit: "percent" as const,
  },
} as const;

function finiteTime(value: Date | null | undefined): number | null {
  if (!value) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? time : null;
}

function round(value: number, decimals = 2): number {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function targetStatus(
  value: number,
  targetValue: number,
  direction: "at-most" | "at-least",
): "met" | "missed" {
  return direction === "at-most"
    ? value <= targetValue
      ? "met"
      : "missed"
    : value >= targetValue
      ? "met"
      : "missed";
}

function measuredMetric(
  definition: (typeof KPI_DEFINITIONS)[keyof typeof KPI_DEFINITIONS],
  eligibleCount: number,
  values: readonly number[],
  note: string,
): OutcomeKpi {
  const sampleSize = values.length;
  const unknownCount = Math.max(0, eligibleCount - sampleSize);
  if (sampleSize === 0) {
    return {
      ...definition,
      baseline: BASELINE,
      value: null,
      status: "insufficient-data",
      sampleSize,
      eligibleCount,
      unknownCount,
      note,
    };
  }
  const rawMean =
    values.reduce((total, current) => total + current, 0) / sampleSize;
  const value = round(rawMean);
  return {
    ...definition,
    baseline: BASELINE,
    value,
    // Keep threshold evaluation on the unrounded value. Rounding is display
    // formatting only: 7.004 days must miss a seven-day target.
    status: targetStatus(rawMean, definition.targetValue, definition.direction),
    sampleSize,
    eligibleCount,
    unknownCount,
    note,
  };
}

function notCollectedMetric(
  definition: (typeof KPI_DEFINITIONS)[keyof typeof KPI_DEFINITIONS],
  eligibleCount: number,
  note: string,
): OutcomeKpi {
  return {
    ...definition,
    baseline: BASELINE,
    value: null,
    status: "not-collected",
    sampleSize: 0,
    eligibleCount,
    unknownCount: eligibleCount,
    note,
  };
}

function caseIsEligible(c: OutcomeCase): boolean {
  return NEW_HIRE_TYPES.has(c.hireType ?? "");
}

function eventTime(event: OutcomeEvent): number | null {
  return finiteTime(event.createdAt);
}

function isGateCCompletion(event: OutcomeEvent): boolean {
  return (
    event.agent === "day1-readiness-gate" &&
    event.title === "Gate C Day-1 readiness confirmed by HR"
  );
}

function isGateCReopen(event: OutcomeEvent): boolean {
  return (
    event.agent === "day1-readiness-gate" &&
    event.title === "Gate C approval invalidated by changed live readiness evidence"
  );
}

function cycleDuration(
  c: OutcomeCase,
  events: readonly OutcomeEvent[],
  asOfTime: number,
): number | null {
  const acceptanceTime = finiteTime(c.offerAcceptanceCompletedAt);
  if (
    acceptanceTime === null ||
    c.offerAcceptanceComplete === false ||
    acceptanceTime > asOfTime ||
    (c.scenarioKey !== null && c.scenarioKey !== undefined) ||
    c.lifecycleStage !== "complete" ||
    c.gateCApprovalStatus !== "approved"
  ) {
    return null;
  }

  const caseEvents = events
    .filter((event) => event.caseId === c.id)
    .map((event) => ({ event, time: eventTime(event) }))
    .filter((entry): entry is { event: OutcomeEvent; time: number } => entry.time !== null)
    .filter((entry) => entry.time <= asOfTime)
    .sort((a, b) => a.time - b.time || (a.event.id ?? 0) - (b.event.id ?? 0));

  // A Gate C completion before a later live-evidence reopen is not valid
  // historical evidence. A subsequent fresh completion is valid again.
  let lastReopen = -Infinity;
  let completion: number | null = null;
  for (const { event, time } of caseEvents) {
    if (isGateCReopen(event)) {
      lastReopen = time;
      completion = null;
    } else if (isGateCCompletion(event) && time > lastReopen) {
      completion = time;
    }
  }
  if (completion === null || completion < acceptanceTime) return null;
  return (completion - acceptanceTime) / DAY_MS;
}

function bgvDuration(
  c: OutcomeCase,
  checks: readonly OutcomeBgvCheck[],
  emails: readonly OutcomeBgvEmail[],
  asOfTime: number,
): number | null {
  const check = checks
    .filter((row) => row.caseId === c.id && row.system === "bgv")
    .sort((a, b) => a.id - b.id)
    .at(-1);
  // Push and poll rows are legacy/demo connector simulation in this schema.
  // They cannot establish a real initiation-to-result measurement. Email is
  // usable only with a non-simulated, completed watch-mailbox message.
  if (!check || check.mode !== "email" || check.status !== "done") return null;
  const requestedAt = finiteTime(check.requestedAt);
  if (requestedAt === null || requestedAt > asOfTime) return null;
  const result = emails
    .filter(
      (email) =>
        email.caseId === c.id &&
        email.checkId === check.id &&
        email.parsedStatus === "completed" &&
        !email.gmailMessageId.toLowerCase().startsWith("simulated-"),
    )
    .map((email) => finiteTime(email.receivedAt))
    .filter((time): time is number => time !== null && time <= asOfTime)
    .sort((a, b) => a - b)[0];
  if (result === undefined || result < requestedAt) return null;
  return (result - requestedAt) / DAY_MS;
}

export function calculateOutcomeKpis(
  input: CalculateOutcomeKpisInput,
): OutcomeKpiResponse {
  const asOfTime = finiteTime(input.asOf);
  if (asOfTime === null) {
    throw new Error("Outcome KPI asOf must be a valid date");
  }
  const period = input.period ?? "30";
  const periodDays = period === "All" ? null : Number(period);
  const lowerBound =
    periodDays === null ? null : asOfTime - periodDays * DAY_MS;
  const supportedDomain =
    input.domain === undefined ||
    input.domain === "Onboarding" ||
    input.domain === "All domains";
  const region = input.region?.trim() || undefined;
  const hireType = input.hireType?.trim() || undefined;
  const cohort =
    supportedDomain
      ? input.cases.filter((c) => {
          const created = finiteTime(c.createdAt);
          return (
            created !== null &&
            created <= asOfTime &&
            (lowerBound === null || created >= lowerBound) &&
            (region === undefined || c.geography === region) &&
            (hireType === undefined || c.hireType === hireType)
          );
        })
      : [];
  const eligible = cohort.filter(caseIsEligible);
  const events = input.events ?? [];
  const checks = input.bgvChecks ?? [];
  const emails = input.bgvEmails ?? [];

  const cycleValues = eligible
    .map((c) => cycleDuration(c, events, asOfTime))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const bgvValues = eligible
    .map((c) => bgvDuration(c, checks, emails, asOfTime))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const cycleNote =
    `${AGENT_FILTER_NOTE} Average is measured only from HR-recorded offer acceptance and a Gate C completion event whose current final approval is approved and case lifecycle is complete; missing, negative, future, simulation, or inconsistent/reopened evidence is conservatively unknown.`;
  const bgvNote =
    `${AGENT_FILTER_NOTE} Average is initiation tracking to receipt of a verified vendor result, not provider execution duration. Only non-simulated email-source timestamps are verifiable here; legacy push/poll simulation and missing provider timestamps are excluded, not treated as target success.`;

  const metrics: OutcomeKpi[] = [
    measuredMetric(
      KPI_DEFINITIONS.cycleTime,
      eligible.length,
      cycleValues,
      cycleNote,
    ),
    notCollectedMetric(
      KPI_DEFINITIONS.day1Readiness,
      eligible.length,
      `${AGENT_FILTER_NOTE} Historical Day-1 readiness snapshots were not captured; current live readiness is not used as a historical rate.`,
    ),
    notCollectedMetric(
      KPI_DEFINITIONS.documentCompleteness,
      eligible.length,
      `${AGENT_FILTER_NOTE} Initial package completeness at first submission was not captured; offer acceptance or current document checkboxes are not a substitute.`,
    ),
    measuredMetric(
      KPI_DEFINITIONS.bgvTurnaround,
      eligible.length,
      bgvValues,
      bgvNote,
    ),
    notCollectedMetric(
      KPI_DEFINITIONS.provisioningOnTime,
      eligible.length,
      `${AGENT_FILTER_NOTE} ITSM access is recorded, but a complete IT-plus-assets request source and J-2 readiness timestamps are not available; no combined rate is fabricated.`,
    ),
    notCollectedMetric(
      KPI_DEFINITIONS.experience,
      eligible.length,
      `${AGENT_FILTER_NOTE} No authoritative 30-day onboarding survey/eNPS source is collected.`,
    ),
    notCollectedMetric(
      KPI_DEFINITIONS.attrition,
      eligible.length,
      `${AGENT_FILTER_NOTE} No authoritative exit source or archived prior-stint exit data can establish 0–90 day attrition.`,
    ),
  ];

  const periodLabel =
    period === "All" ? "all recorded time" : `the last ${period} days`;
  const domainLabel = supportedDomain
    ? ""
    : " Unsupported domain requested; no cases are eligible.";
  return {
    asOf: input.asOf.toISOString(),
    cohortLabel: `Cases created in-period (${periodLabel}; not a joining-date cohort).${domainLabel} Agent filtering is intentionally not applied.`,
    caseCount: cohort.length,
    metrics,
  };
}

export { KPI_DEFINITIONS };