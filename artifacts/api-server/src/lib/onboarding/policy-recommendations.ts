import { createHash } from "node:crypto";
import type { OnbChecklistProfileCriteria } from "@workspace/db/schema";
import {
  compileLearningWorkforceSteps,
  WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION,
} from "./workforce-step-runtime";

export const LEARNING_RECOMMENDATION_MIN_SAMPLE = 5;
const DAY = 86_400_000;

export type LearningPolicy = {
  schemaVersion?: typeof WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION;
  timing: { anchor: "joining-date"; offsetDays: number };
  sequence?: string[];
  steps?: Array<Record<string, unknown>>;
  channel: "manager-led";
  ownership: string;
};

export type LearningRecommendationCase = {
  id: number;
  createdAt: Date;
  scenarioKey: string | null;
  lifecycleStage: string;
  /** Current dedicated Gate C approval; historical terminal rows without it are not evidence. */
  gateCApprovalStatus: string | null;
  checklistProfileId: string;
  checklistProfileVersion: number | null;
  checklistProfileName: string;
  processPolicySnapshot: Record<string, unknown>;
};

export type LearningRecommendationEvent = {
  caseId: number | null;
  agent: string;
  engine: string;
  title: string;
  detail: string;
  createdAt: Date;
};

export type CohortLearningRecommendation = {
  recommendation: {
    type: "cohort-learning-default";
    target: {
      profileId: string;
      expectedProfileVersion: number;
      profileName: string;
      criteria: OnbChecklistProfileCriteria;
      priority: number;
    };
    learning: LearningPolicy;
    rationale: string;
  };
  evidenceSnapshot: {
    methodologyVersion: "learning-cohort-v1";
    cohortDefinition: string;
    outcomeDefinition: string;
    window: { startedAt: string; endedAt: string; days: number };
    sample: {
      candidateCases: number;
      verifiedOutcomes: number;
      excludedDemoOrSimulation: number;
      missingOutcomeEvidence: number;
    };
    outcome: {
      meanDaysToVerifiedReadiness: number;
      uncertainty95PercentDays: { low: number; high: number } | null;
      observedOutcomeDates: string[];
      caseReferences: number[];
    };
    missingness: string[];
    uncertainty: string;
    evidenceFingerprint: string;
  };
};

export type BroaderCompatibleCohortEvidence = {
  scope: "same-tenant-compatible-profile";
  status: "descriptive-only";
  notEligibleForPublication: true;
  target: {
    profileId: string;
    profileName: string;
    currentProfileVersion: number;
    exactCohortVerifiedOutcomes: number;
  };
  cohortDefinition: string;
  compatibilityDefinition: string;
  outcomeDefinition: string;
  window: { startedAt: string; endedAt: string; days: number };
  sample: {
    candidateCases: number;
    verifiedOutcomes: number;
    excludedDemoOrSimulation: number;
    missingOutcomeEvidence: number;
  };
  outcome: {
    meanDaysToVerifiedReadiness: number | null;
    uncertainty95PercentDays: { low: number; high: number } | null;
    observedOutcomeDates: string[];
    caseReferences: number[];
  };
  missingness: string[];
  uncertainty: string;
};

export type CohortLearningAnalysis = {
  asOf: string;
  window: { startedAt: string; endedAt: string; days: number };
  methodologyVersion: "learning-cohort-v1";
  recommendations: CohortLearningRecommendation[];
  fallback: {
    status: "insufficient-evidence";
    message: string;
    candidateCases: number;
    verifiedOutcomes: number;
    excludedDemoOrSimulation: number;
    missingOutcomeEvidence: number;
    /**
     * Wider same-tenant evidence is informational only. It is never converted
     * into a policy proposal because the exact profile-version cohort is sparse.
     */
    broaderEvidence: BroaderCompatibleCohortEvidence[];
  } | null;
};

type CurrentProfile = {
  profileId: string;
  version: number;
  name: string;
  criteria: OnbChecklistProfileCriteria;
  priority: number;
  enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasOnlyRuntimeStepFields(step: Record<string, unknown>): boolean {
  if (!onlyKeys(step, [
    "id", "label", "responsibleRole", "assignedTo", "mandatory",
    "evidenceRequired", "nonblocking", "prerequisites", "parallelGroup",
    "permittedChannels", "timing",
  ])) return false;
  if (step.timing === undefined) return true;
  if (!isRecord(step.timing) || !onlyKeys(step.timing, [
    "anchor", "notBeforeOffsetDays", "dueOffsetDays", "escalation",
  ])) return false;
  return step.timing.escalation === undefined ||
    (isRecord(step.timing.escalation) && onlyKeys(step.timing.escalation, [
      "offsetDays", "responsibleRole", "assignedTo",
    ]));
}

/**
 * Returns only the versioned, compiler-supported learning-policy surface.
 * This is deliberately stricter than the compiler's fallback behavior:
 * publication must never store an unsupported value merely because runtime
 * can turn it into a policy-review task.
 */
export function parseLearningPolicy(value: unknown): LearningPolicy | null {
  if (!isRecord(value) || !onlyKeys(value, ["schemaVersion", "timing", "sequence", "steps", "channel", "ownership"])) return null;
  const raw = value;
  const timing = raw.timing;
  if (!isRecord(timing) || !onlyKeys(timing, ["anchor", "offsetDays"])) return null;
  const anchor = timing.anchor;
  const offsetDays = timing.offsetDays;
  const sequence = raw.sequence;
  const steps = raw.steps;
  if (
    (raw.schemaVersion !== undefined && raw.schemaVersion !== WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION) ||
    anchor !== "joining-date" ||
    typeof offsetDays !== "number" || !Number.isInteger(offsetDays) || offsetDays < -90 || offsetDays > 180 ||
    raw.channel !== "manager-led" ||
    typeof raw.ownership !== "string" || !raw.ownership.trim() || raw.ownership.trim().length > 120 ||
    (sequence !== undefined && (!Array.isArray(sequence) || sequence.length < 1 || sequence.length > 24 ||
      sequence.some((step) => typeof step !== "string" || !step.trim() || step.trim().length > 120))) ||
    (steps !== undefined && (!Array.isArray(steps) || steps.length < 1 || steps.length > 24 ||
      steps.some((step) => !isRecord(step) || !hasOnlyRuntimeStepFields(step)))) ||
    (sequence === undefined && steps === undefined) ||
    (sequence !== undefined && steps !== undefined)
  ) return null;
  const policy: LearningPolicy = {
    ...(raw.schemaVersion === WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION
      ? { schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION }
      : {}),
    timing: { anchor: "joining-date", offsetDays },
    ...(Array.isArray(sequence) ? { sequence: sequence.map((step) => step.trim()) } : {}),
    ...(Array.isArray(steps) ? { steps: steps.map((step) => ({ ...step })) } : {}),
    channel: raw.channel,
    ownership: raw.ownership.trim(),
  };
  // Run the actual runtime compiler during analysis and edits. A stable,
  // arbitrary valid joining date validates policy shape without publishing or
  // executing anything.
  return compileLearningWorkforceSteps({
    processPolicySnapshot: { processPolicy: { learning: policy } },
    joiningDate: "2000-01-01",
  }).issues.length === 0 ? policy : null;
}

/** Compile immediately before profile publication; never adopt fallback tasks. */
export function learningPolicyRuntimeIssue(learning: LearningPolicy): string | null {
  const result = compileLearningWorkforceSteps({
    processPolicySnapshot: { processPolicy: { learning } },
    joiningDate: "2000-01-01",
  });
  return result.issues[0]?.message ?? null;
}

function snapshotLearningPolicy(c: LearningRecommendationCase): LearningPolicy | null {
  const root = c.processPolicySnapshot.processPolicy;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return parseLearningPolicy((root as Record<string, unknown>).learning);
}

function isSimulated(c: LearningRecommendationCase, events: readonly LearningRecommendationEvent[]) {
  if (c.scenarioKey !== null) return true;
  return events.some((event) => {
    if (event.caseId !== c.id) return false;
    return /\b(simulat(?:ed|ion)|demo)\b/i.test(`${event.engine} ${event.title} ${event.detail}`);
  });
}

function verifiedOutcome(c: LearningRecommendationCase, events: readonly LearningRecommendationEvent[], asOf: number) {
  if (c.lifecycleStage !== "complete" || c.gateCApprovalStatus !== "approved") {
    return { outcome: null, reopenedWithoutFreshConfirmation: false };
  }
  const entries = events
    .filter((event) =>
      event.caseId === c.id &&
      Number.isFinite(event.createdAt.getTime()) &&
      event.createdAt.getTime() <= asOf)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let outcome: Date | null = null;
  let reopenedWithoutFreshConfirmation = false;
  for (const event of entries) {
    if (
      event.agent === "day1-readiness-gate" &&
      event.title === "Gate C approval invalidated by changed live readiness evidence"
    ) {
      outcome = null;
      reopenedWithoutFreshConfirmation = true;
    } else if (
      event.agent === "day1-readiness-gate" &&
      event.engine === "human" &&
      event.title === "Gate C Day-1 readiness confirmed by HR"
    ) {
      outcome = event.createdAt;
      reopenedWithoutFreshConfirmation = false;
    }
  }
  return {
    outcome,
    reopenedWithoutFreshConfirmation,
  };
}

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function fingerprint(value: object) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Descriptive cohort analysis only. It never turns unrecorded data into a
 * recommendation and never asserts that a historical policy caused an outcome.
 */
export function analyzeCohortLearning(input: {
  cases: readonly LearningRecommendationCase[];
  events: readonly LearningRecommendationEvent[];
  profiles: readonly CurrentProfile[];
  asOf: Date;
  windowDays: number;
  /** The dedicated demo tenant is never a source of production evidence. */
  excludeAllAsDemo?: boolean;
}): CohortLearningAnalysis {
  const asOf = input.asOf.getTime();
  if (!Number.isFinite(asOf)) throw new Error("asOf must be a valid date.");
  const started = asOf - input.windowDays * DAY;
  const base = {
    startedAt: new Date(started).toISOString(),
    endedAt: input.asOf.toISOString(),
    days: input.windowDays,
  };
  type CohortRow = {
    c: LearningRecommendationCase;
    outcome: Date | null;
    excludedDemoOrSimulation: boolean;
    reopenedWithoutFreshConfirmation: boolean;
  };
  type CompatibleCohortRow = CohortRow & {
    policy: LearningPolicy;
    policyKey: string;
    currentProfile: CurrentProfile;
  };
  type CohortGroup = {
    target: CurrentProfile;
    policy: LearningPolicy;
    rows: CohortRow[];
  };
  // A denominator belongs to the exact version-and-policy cohort that could
  // produce this proposal. Do not show tenant-wide totals on a proposal: a
  // different profile's missing or excluded outcomes say nothing about this
  // recommendation's evidence.
  const groups = new Map<string, CohortGroup>();
  const compatibleRows: CompatibleCohortRow[] = [];
  const currentProfileById = new Map(
    input.profiles.filter((profile) => profile.enabled).map((profile) => [profile.profileId, profile]),
  );
  let candidateCases = 0;
  let excludedDemoOrSimulation = 0;
  let missingOutcomeEvidence = 0;
  let verifiedOutcomes = 0;

  for (const c of input.cases) {
    const created = c.createdAt.getTime();
    if (!Number.isFinite(created) || created < started || created > asOf) continue;
    candidateCases++;
    const policy = snapshotLearningPolicy(c);
    const currentProfile = currentProfileById.get(c.checklistProfileId);
    if (!policy || !currentProfile || c.checklistProfileId === "default") continue;
    const excluded = input.excludeAllAsDemo || isSimulated(c, input.events);
    const verified = excluded ? null : verifiedOutcome(c, input.events, asOf);
    const row: CompatibleCohortRow = {
      c,
      policy,
      policyKey: JSON.stringify(policy),
      currentProfile,
      outcome: verified?.outcome ?? null,
      excludedDemoOrSimulation: excluded,
      reopenedWithoutFreshConfirmation: verified?.reopenedWithoutFreshConfirmation ?? false,
    };
    compatibleRows.push(row);
    if (c.checklistProfileVersion !== currentProfile.version) continue;
    const key = `${currentProfile.profileId}:${currentProfile.version}:${row.policyKey}`;
    const group = groups.get(key) ?? { target: currentProfile, policy, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
    if (excluded) {
      excludedDemoOrSimulation++;
      continue;
    }
    if (!row.outcome) {
      missingOutcomeEvidence++;
      continue;
    }
    verifiedOutcomes++;
  }

  const broaderEvidence = [...groups.values()].flatMap((group): BroaderCompatibleCohortEvidence[] => {
    const exactRows = group.rows.filter((row): row is CohortRow & { outcome: Date } => row.outcome !== null);
    if (exactRows.length >= LEARNING_RECOMMENDATION_MIN_SAMPLE) return [];
    // Compatibility is deliberately narrow: the caller already supplied one
    // tenant, and a wider row must retain both the canonical profile identity
    // and the exact parsed executable policy. Profile versions are reported,
    // not assumed equivalent, and no mixed-policy aggregate is produced.
    const rows = compatibleRows.filter(
      (row) => row.currentProfile.profileId === group.target.profileId && row.policyKey === JSON.stringify(group.policy),
    );
    if (rows.length <= group.rows.length) return [];
    const outcomeRows = rows.filter((row): row is CompatibleCohortRow & { outcome: Date } => row.outcome !== null);
    const validOutcomeRows = outcomeRows.filter(({ c, outcome }) => {
      const value = (outcome.getTime() - c.createdAt.getTime()) / DAY;
      return value >= 0 && Number.isFinite(value);
    });
    const usableValues = validOutcomeRows.map(({ c, outcome }) => (outcome.getTime() - c.createdAt.getTime()) / DAY);
    const mean = usableValues.length
      ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length
      : null;
    const variance = mean !== null && usableValues.length > 1
      ? usableValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (usableValues.length - 1)
      : 0;
    const standardError = Math.sqrt(variance) / Math.sqrt(usableValues.length);
    return [{
      scope: "same-tenant-compatible-profile",
      status: "descriptive-only",
      notEligibleForPublication: true,
      target: {
        profileId: group.target.profileId,
        profileName: group.target.name,
        currentProfileVersion: group.target.version,
        exactCohortVerifiedOutcomes: exactRows.length,
      },
      cohortDefinition: `Same-tenant cases created in the ${input.windowDays}-day window for ${group.target.name} across profile versions, retaining the identical historical executable learning policy.`,
      compatibilityDefinition: `Same tenant, same canonical profile ID (${group.target.profileId}), and an identical parsed manager-led learning policy. Profile versions are wider context only and are not treated as interchangeable for publication.`,
      outcomeDefinition: "Days from case creation to a dated, human-recorded Day-1 Readiness confirmation.",
      window: base,
      sample: {
        candidateCases: rows.length,
        verifiedOutcomes: usableValues.length,
        excludedDemoOrSimulation: rows.filter((row) => row.excludedDemoOrSimulation).length,
        missingOutcomeEvidence: rows.filter((row) => !row.excludedDemoOrSimulation && row.outcome === null).length,
      },
      outcome: {
        meanDaysToVerifiedReadiness: mean === null ? null : rounded(mean),
        uncertainty95PercentDays: mean !== null && usableValues.length > 1
          ? { low: rounded(Math.max(0, mean - 1.96 * standardError)), high: rounded(mean + 1.96 * standardError) }
          : null,
        observedOutcomeDates: validOutcomeRows
          .map(({ outcome }) => outcome.toISOString())
          .sort(),
        caseReferences: validOutcomeRows
          .map(({ c }) => c.id)
          .sort((a, b) => a - b),
      },
      missingness: [
        "Demo and simulation cases are excluded from outcomes.",
        "Cases without a final, dated HR Day-1 Readiness confirmation are missing outcome evidence.",
        "A Day-1 Readiness confirmation invalidated by a later live-evidence reopen is missing until a fresh later human confirmation is recorded.",
      ],
      uncertainty: "Descriptive wider-scope evidence only; it is not causal, does not establish confidence for this profile version, and cannot be published or adopted.",
    }];
  });

  const recommendations = [...groups.values()].flatMap((group): CohortLearningRecommendation[] => {
    const rows = group.rows.filter((row): row is CohortRow & { outcome: Date } => row.outcome !== null);
    if (rows.length < LEARNING_RECOMMENDATION_MIN_SAMPLE) return [];
    const target = group.target;
    const cohortCandidateCases = group.rows.length;
    const cohortExcludedDemoOrSimulation = group.rows.filter((row) => row.excludedDemoOrSimulation).length;
    const cohortMissingOutcomeEvidence = group.rows.filter(
      (row) => !row.excludedDemoOrSimulation && row.outcome === null,
    ).length;
    const values = rows.map(({ c, outcome }) => (outcome.getTime() - c.createdAt.getTime()) / DAY);
    if (values.some((value) => value < 0 || !Number.isFinite(value))) return [];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
      : 0;
    const standardError = Math.sqrt(variance) / Math.sqrt(values.length);
    const uncertainty = values.length > 1
      ? { low: rounded(Math.max(0, mean - 1.96 * standardError)), high: rounded(mean + 1.96 * standardError) }
      : null;
    const policy = group.policy;
    const evidenceCore = {
      methodologyVersion: "learning-cohort-v1" as const,
      cohortDefinition: `Cases created in the ${input.windowDays}-day window, matched to ${target.name} v${target.version}, with an explicit historical learning policy and a final HR Day-1 Readiness outcome.`,
      outcomeDefinition: "Days from case creation to a dated, human-recorded Day-1 Readiness confirmation.",
      window: base,
      sample: {
        candidateCases: cohortCandidateCases,
        verifiedOutcomes: rows.length,
        excludedDemoOrSimulation: cohortExcludedDemoOrSimulation,
        missingOutcomeEvidence: cohortMissingOutcomeEvidence,
      },
      outcome: {
        meanDaysToVerifiedReadiness: rounded(mean),
        uncertainty95PercentDays: uncertainty,
        observedOutcomeDates: rows.map(({ outcome }) => outcome.toISOString()).sort(),
        caseReferences: rows.map(({ c }) => c.id).sort((a, b) => a - b),
      },
      missingness: [
        "Cases without a final, dated HR Day-1 Readiness confirmation are excluded from the outcome denominator.",
        "A Day-1 Readiness confirmation invalidated by a later live-evidence reopen is missing until a fresh later human confirmation is recorded.",
        "Cases with a learning policy outside the executable workforce-step runtime contract are not proposed.",
      ],
      uncertainty: "Descriptive historical association only; this non-randomized cohort does not establish that the learning policy caused the observed outcome.",
    };
    const evidenceFingerprint = fingerprint({ target: { profileId: target.profileId, version: target.version }, policy, evidenceCore });
    return [{
      recommendation: {
        type: "cohort-learning-default",
        target: {
          profileId: target.profileId,
          expectedProfileVersion: target.version,
          profileName: target.name,
          criteria: target.criteria,
          priority: target.priority,
        },
        learning: policy,
        rationale: `Observed ${rows.length} non-demo cases with dated HR-confirmed Day-1 readiness. Review the descriptive result before publishing; it is not causal evidence.`,
      },
      evidenceSnapshot: { ...evidenceCore, evidenceFingerprint },
    }];
  });

  return {
    asOf: input.asOf.toISOString(),
    window: base,
    methodologyVersion: "learning-cohort-v1",
    recommendations,
    fallback: recommendations.length && broaderEvidence.length === 0 ? null : {
      status: "insufficient-evidence",
      message: recommendations.length
        ? `Some exact current profile-version cohorts remain insufficient: at least ${LEARNING_RECOMMENDATION_MIN_SAMPLE} non-demo cases with dated HR-confirmed outcomes and a compiler-supported workforce learning policy are required. Any wider compatible cohort below is descriptive only and cannot be adopted.`
        : `No publishable recommendation: at least ${LEARNING_RECOMMENDATION_MIN_SAMPLE} non-demo cases with dated HR-confirmed outcomes in the exact current profile-version cohort and a compiler-supported workforce learning policy are required. Any wider compatible cohort below is descriptive only and cannot be adopted. Expert-authored starter guidance remains separate from measured evidence.`,
      candidateCases,
      verifiedOutcomes,
      excludedDemoOrSimulation,
      missingOutcomeEvidence,
      broaderEvidence,
    },
  };
}