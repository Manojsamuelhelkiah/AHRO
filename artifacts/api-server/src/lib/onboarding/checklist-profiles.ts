import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  onbChecklistProfiles,
  type OnbChecklistItemOverride,
  type OnbChecklistProfileCriteria,
  type OnbChecklistTemplateItem,
  type OnbWorkforceContext,
} from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  acquireChecklistPolicyLock,
  getEffectiveChecklist,
  type OnboardingDbTransaction,
  validateChecklist,
} from "./settings";
import {
  classifyWorkforceContext,
  enforceContextReviewGate,
} from "./workforce-policies";

type ChecklistProfileReadClient = Pick<typeof db, "select">;

export type EmployeeChecklistAttributes = {
  /** A case may have no HR band; do not substitute worker category for it. */
  band: string | null;
  role: string;
  employmentType: string;
  location: string;
  roleFamily?: string | null;
  department?: string | null;
  legalEntity?: string | null;
  businessUnit?: string | null;
  industry?: string | null;
  workCountry?: string | null;
  workState?: string | null;
  site?: string | null;
  employmentArrangement?: string | null;
  workerCategory?: string | null;
  payBasis?: string | null;
  shiftPattern?: string | null;
  workEnvironment?: string | null;
  hiringMode?: string | null;
  safetyCritical?: string | null;
};

/** Stable base facts from a case/intake row that participate in profile matching. */
export type ChecklistProfileBaseCaseFields = {
  workerBand?: string | null;
  role: string;
  hireType: string;
  workerCategory?: string | null;
  geography: string;
  department?: string | null;
  legalEntity?: string | null;
};

/**
 * The sole conversion boundary between stored/proposed workforce context and
 * profile matching. Context facts win when explicitly supplied; base case
 * fields preserve all legacy matching behavior. In particular, an omitted
 * safety-critical fact remains unknown (`null`) rather than being optimized
 * into the safer `false` profile branch.
 */
export function checklistProfileMatchingAttributes(
  workforceContext: OnbWorkforceContext | null | undefined,
  base: ChecklistProfileBaseCaseFields,
): EmployeeChecklistAttributes {
  const context = workforceContext ?? {};
  return {
    band: base.workerBand ?? context.band ?? null,
    role: base.role,
    employmentType: base.hireType,
    location: base.geography,
    roleFamily: context.roleFamily ?? null,
    department: context.department ?? base.department ?? null,
    legalEntity: context.legalEntity ?? base.legalEntity ?? null,
    businessUnit: context.businessUnit ?? null,
    industry: context.industry ?? null,
    workCountry: context.workCountry ?? base.geography,
    workState: context.workState ?? null,
    site: context.site ?? null,
    employmentArrangement: context.employmentArrangement ?? null,
    workerCategory: context.workerCategory ?? base.workerCategory ?? null,
    payBasis: context.payBasis ?? null,
    shiftPattern: context.shiftPattern ?? null,
    workEnvironment: context.workEnvironment ?? null,
    hiringMode: context.hiringMode ?? null,
    safetyCritical: context.safetyCritical === undefined
      ? null
      : context.safetyCritical ? "true" : "false",
  };
}

export type EffectiveWorkforcePolicy = {
  profile: Awaited<ReturnType<typeof resolveChecklistProfileInTransaction>>;
  attributes: EmployeeChecklistAttributes;
  classification: ReturnType<typeof classifyWorkforceContext>;
  effectiveItems: OnbChecklistTemplateItem[];
};

/**
 * Single policy-selection boundary for every intake, rebase and preview path.
 * Matching, deterministic context classification, and the fail-closed context
 * review gate must always be calculated from the same facts.
 */
export async function resolveEffectiveWorkforcePolicyInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  workforceContext: OnbWorkforceContext | null | undefined,
  base: ChecklistProfileBaseCaseFields,
): Promise<EffectiveWorkforcePolicy> {
  const attributes = checklistProfileMatchingAttributes(workforceContext, base);
  const profile = await resolveChecklistProfileInTransaction(tx, organizationId, attributes);
  const classification = classifyWorkforceContext(workforceContext);
  return {
    profile,
    attributes,
    classification,
    effectiveItems: enforceContextReviewGate(profile.items, classification),
  };
}

export async function resolveEffectiveWorkforcePolicy(
  organizationId: string,
  workforceContext: OnbWorkforceContext | null | undefined,
  base: ChecklistProfileBaseCaseFields,
): Promise<EffectiveWorkforcePolicy> {
  return db.transaction((tx) =>
    resolveEffectiveWorkforcePolicyInTransaction(tx, organizationId, workforceContext, base),
  );
}

export type ChecklistProfileVersion = typeof onbChecklistProfiles.$inferSelect;
type PolicyRule = { field: keyof EmployeeChecklistAttributes; values: string[] };
type PolicyMatchGroup = { operator: "all" | "any"; rules: PolicyRule[] };

function policyMatchGroup(policy: Record<string, unknown> | undefined): PolicyMatchGroup | null {
  const raw = policy?.match;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as { operator?: unknown; rules?: unknown };
  if ((candidate.operator !== "all" && candidate.operator !== "any") || !Array.isArray(candidate.rules)) return null;
  const rules = candidate.rules.flatMap((rule): PolicyRule[] => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return [];
    const item = rule as { field?: unknown; values?: unknown };
    if (typeof item.field !== "string" || !Array.isArray(item.values)) return [];
    const values = item.values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map(normalizeCriterion);
    return values.length ? [{ field: item.field as keyof EmployeeChecklistAttributes, values }] : [];
  });
  return rules.length === candidate.rules.length ? { operator: candidate.operator, rules } : null;
}

export const normalizeCriterion = (value: string | null | undefined): string =>
  (value ?? "").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

export function normalizeCriteria(criteria: OnbChecklistProfileCriteria): OnbChecklistProfileCriteria {
  return Object.fromEntries(
    Object.entries(criteria)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, value]) => [key, normalizeCriterion(value)]),
  );
}

export function profileMatches(
  criteria: OnbChecklistProfileCriteria,
  attributes: EmployeeChecklistAttributes,
  processPolicy?: Record<string, unknown>,
): boolean {
  const normalized = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, normalizeCriterion(value)]),
  ) as EmployeeChecklistAttributes;
  if (!Object.entries(criteria).every(([key, value]) => normalized[key as keyof EmployeeChecklistAttributes] === value)) return false;
  const group = policyMatchGroup(processPolicy);
  if (!group) return true;
  const ruleMatches = (rule: PolicyRule) => rule.values.includes(normalized[rule.field] ?? "");
  return group.operator === "all" ? group.rules.every(ruleMatches) : group.rules.some(ruleMatches);
}

/** Two conjunctions overlap unless they disagree on at least one criterion supplied by both. */
export function criteriaOverlap(a: OnbChecklistProfileCriteria, b: OnbChecklistProfileCriteria): boolean {
  return !Object.keys(a).some((key) => {
    const other = b[key as keyof OnbChecklistProfileCriteria];
    return other !== undefined && other !== a[key as keyof OnbChecklistProfileCriteria];
  });
}

/** Conservative conflict detection: reject when overlap cannot be disproved. */
export function profilesCouldOverlap(
  a: OnbChecklistProfileCriteria,
  aPolicy: Record<string, unknown> | undefined,
  b: OnbChecklistProfileCriteria,
  bPolicy: Record<string, unknown> | undefined,
): boolean {
  if (!criteriaOverlap(a, b)) return false;
  const aGroup = policyMatchGroup(aPolicy);
  const bGroup = policyMatchGroup(bPolicy);
  // An OR branch may overlap through a branch not represented by a single
  // conjunction. Treat it as ambiguous unless existing criteria disprove it.
  if (aGroup?.operator === "any" || bGroup?.operator === "any") return true;
  const constraints = (criteria: OnbChecklistProfileCriteria, group: PolicyMatchGroup | null) => {
    const result = new Map<string, Set<string>>();
    for (const [field, value] of Object.entries(criteria)) result.set(field, new Set([value]));
    for (const rule of group?.rules ?? []) {
      const previous = result.get(rule.field);
      result.set(rule.field, previous ? new Set([...previous].filter((value) => rule.values.includes(value))) : new Set(rule.values));
    }
    return result;
  };
  const left = constraints(a, aGroup);
  const right = constraints(b, bGroup);
  for (const [field, values] of left) {
    const other = right.get(field);
    if (other && ![...values].some((value) => other.has(value))) return false;
  }
  return true;
}

export function applyChecklistOverrides(
  base: readonly OnbChecklistTemplateItem[],
  overrides: readonly OnbChecklistItemOverride[],
  strictAdditive = true,
): OnbChecklistTemplateItem[] {
  const byId = new Map(base.map((item) => [item.id, { ...item }]));
  const stageRank: Record<OnbChecklistTemplateItem["enforcementStage"], number> = {
    "before-workstreams": 0,
    "before-employee-communications": 1,
    "before-day1-review": 2,
  };
  for (const override of overrides) {
    const current = byId.get(override.id);
    if (!current && (override.label === undefined || override.order === undefined)) {
      throw new Error(`New checklist item "${override.id}" requires label and order.`);
    }
    // Profiles are additive. Organization-level mandatory requirements are
    // non-waivable; a targeted policy may only add or strengthen gates.
    if (strictAdditive && current?.mandatory && (override.enabled === false || override.mandatory === false)) {
      throw new Error(`Mandatory baseline item "${override.id}" cannot be disabled or weakened by a targeted profile.`);
    }
    if (strictAdditive && current?.mandatory) {
      if (override.enforcementStage && stageRank[override.enforcementStage] > stageRank[current.enforcementStage]) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot be enforced at a later stage by a targeted profile.`);
      }
      if (current.evidenceRequired && override.evidenceRequired === false) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot remove required evidence.`);
      }
      if (current.completionAuthority && override.completionAuthority && override.completionAuthority !== current.completionAuthority) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot change completion authority.`);
      }
      if (current.responsibleRole && override.responsibleRole && override.responsibleRole !== current.responsibleRole) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot change designated responsible role.`);
      }
      if (current.executor && override.executor && override.executor !== current.executor) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot change executor.`);
      }
      if (override.prerequisites && (current.prerequisites ?? []).some((id) => !override.prerequisites!.includes(id))) {
        throw new Error(`Mandatory baseline item "${override.id}" cannot remove a prerequisite.`);
      }
    }
    byId.set(override.id, {
      id: override.id,
      label: override.label ?? current!.label,
      order: override.order ?? current!.order,
      // A profile is an applicability overlay, not a waiver authority. It
      // cannot clear an immutable policy bit or make that item skippable.
      nonWaivableSafety: current?.nonWaivableSafety === true,
      // Migration-review classification is equally inherited metadata. A
      // profile overlay must not make a historical hold disappear.
      migrationReviewHold: current?.migrationReviewHold === true,
      enabled: current?.nonWaivableSafety === true ? true : (override.enabled ?? current?.enabled ?? true),
      mandatory: current?.nonWaivableSafety === true ? true : (override.mandatory ?? current?.mandatory ?? false),
      enforcementStage: override.enforcementStage ?? current?.enforcementStage ?? "before-day1-review",
        evidenceRequired: override.evidenceRequired ?? current?.evidenceRequired,
        responsibleRole: override.responsibleRole ?? current?.responsibleRole,
        completionAuthority: override.completionAuthority ?? current?.completionAuthority,
        executor: override.executor ?? current?.executor,
        prerequisites: override.prerequisites ?? current?.prerequisites,
    });
  }
  const result = [...byId.values()].sort((a, b) => a.order - b.order);
  const error = validateChecklist(result);
  if (error) throw new Error(error);
  return result;
}

export function mergeChecklistReadiness(
  items: readonly OnbChecklistTemplateItem[],
  previous: readonly { key: string; status: string; note?: string }[],
  previousSnapshot?: readonly OnbChecklistTemplateItem[],
) {
  const prior = new Map(previous.map((item) => [item.key, item]));
  const priorDefinitions = new Map((previousSnapshot ?? []).map((item) => [item.id, item]));
  return items
    .filter((item) => item.enabled)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const old = prior.get(item.id);
      const priorDefinition = priorDefinitions.get(item.id);
      const reverify = Boolean(priorDefinition && (
        priorDefinition.evidenceRequired !== item.evidenceRequired ||
        priorDefinition.responsibleRole !== item.responsibleRole ||
        priorDefinition.completionAuthority !== item.completionAuthority ||
        priorDefinition.enforcementStage !== item.enforcementStage ||
        JSON.stringify(priorDefinition.prerequisites ?? []) !== JSON.stringify(item.prerequisites ?? [])
      ));
      return {
        key: item.id,
        id: item.id,
        label: item.label,
        status: reverify ? "pending" : old?.status ?? "pending",
        ...(reverify || old?.note === undefined ? {} : { note: old.note }),
        order: item.order,
        mandatory: item.mandatory,
        enforcementStage: item.enforcementStage,
        evidenceRequired: item.evidenceRequired,
        responsibleRole: item.responsibleRole,
        completionAuthority: item.completionAuthority,
        executor: item.executor,
        prerequisites: item.prerequisites,
      };
    });
}

/** A changed job context invalidates every evidence-derived clearance. */
export function invalidateEvidenceReadinessForContextChange(
  items: readonly OnbChecklistTemplateItem[],
  readiness: readonly { key: string; label: string; status: string; note?: string }[],
) {
  const evidenceIds = new Set(items.filter((item) => item.evidenceRequired).map((item) => item.id));
  return readiness.map((item) => evidenceIds.has(item.key)
    ? { ...item, status: "pending" }
    : item);
}

const CHECKLIST_STAGE_ORDER = [
  "before-workstreams",
  "before-employee-communications",
  "before-day1-review",
] as const;

const CHECKPOINT_PASSED_GATES = new Map<string, number>([
  ["initial", 0],
  ["plan", 0],
  ["intake-approved", 0],
  ["plan-approved", 0],
  ["blocked:before-workstreams", 0],
  ["workstreams-complete", 1],
  ["blocked:before-employee-communications", 1],
  ["communications-complete", 2],
  ["blocked:before-day1-review", 2],
  ["review-complete", 3],
  ["blocked:re-review", 3],
]);

/** Returns the furthest immutable execution boundary already reached. */
export function establishedChecklistBoundary(
  current: { orchestrationCheckpoint: string | null; lifecycleStage: string },
): number | undefined {
  if (current.lifecycleStage === "day1-review" || current.lifecycleStage === "complete") return 3;
  return current.orchestrationCheckpoint === null
    ? undefined
    : CHECKPOINT_PASSED_GATES.get(current.orchestrationCheckpoint);
}

export function activeReplacementDecision(
  current: { orchestrationCheckpoint: string | null; lifecycleStage: string },
  items: readonly OnbChecklistTemplateItem[],
  readiness: readonly { key: string; status: string }[],
): { ok: true; forceReReview: boolean } | { ok: false; reason: string } {
  const readinessById = new Map(readiness.map((item) => [item.key, item.status]));
  const passedGateCount = establishedChecklistBoundary(current);
  if (passedGateCount === undefined) {
    return {
      ok: false,
      reason: "This case is not paused at a recognized orchestration boundary, so its checklist cannot be replaced safely.",
    };
  }
  if (passedGateCount > 0) {
    return {
      ok: false,
      reason: "This case has already passed the workstream execution boundary, so its active checklist cannot be replaced.",
    };
  }
  const unmetPassedGate = items.find((item) =>
    item.enabled &&
    item.mandatory &&
    readinessById.get(item.id) !== "ready" &&
    CHECKLIST_STAGE_ORDER.indexOf(item.enforcementStage) < passedGateCount);
  if (!unmetPassedGate) return { ok: true, forceReReview: false };
  return {
    ok: false,
    reason: `Replacement would add unmet requirement "${unmetPassedGate.label}" after its ${unmetPassedGate.enforcementStage.replace("before-", "before ")} gate has already passed.`,
  };
}

export function validateProfilesAgainstBase(
  base: { items: readonly OnbChecklistTemplateItem[] },
  profiles: readonly Pick<ChecklistProfileVersion, "name" | "overrides" | "processPolicy">[],
): void {
  for (const profile of profiles) {
    try {
      applyChecklistOverrides(base.items, profile.overrides, profile.processPolicy?.semanticsVersion === 2);
    } catch (error) {
      throw new Error(`Checklist profile "${profile.name}" would become invalid with this default checklist: ${error instanceof Error ? error.message : "invalid overrides"}`);
    }
  }
}

export function resolveFromProfiles(
  base: { version: number; items: OnbChecklistTemplateItem[] },
  profiles: readonly ChecklistProfileVersion[],
  attributes: EmployeeChecklistAttributes,
  organizationId?: string,
) {
  const matched = profiles
    .filter((profile) => organizationId === undefined || profile.organizationId === organizationId)
    .filter((profile) => profile.enabled && profileMatches(profile.criteria, attributes, profile.processPolicy))
    .sort((a, b) => b.priority - a.priority || a.profileId.localeCompare(b.profileId));
  const selected = matched[0];
  if (!selected) {
    return {
      templateVersion: base.version,
      profileId: "default",
      profileName: "Organization default",
      profileVersion: base.version,
      matchedCriteria: {} as OnbChecklistProfileCriteria,
      explanation: "No targeted profile matched; organization default selected.",
      items: base.items.map((item) => ({ ...item })),
      processPolicy: {},
    };
  }
  return {
    templateVersion: base.version,
    profileId: selected.profileId,
    profileName: selected.name,
    profileVersion: selected.version,
    matchedCriteria: selected.criteria,
    explanation: `Matched ${Object.entries(selected.criteria).map(([key, value]) => `${key}="${value}"`).join(" and ")}; selected priority ${selected.priority}.`,
    items: applyChecklistOverrides(base.items, selected.overrides, selected.processPolicy?.semanticsVersion === 2),
    processPolicy: selected.processPolicy,
  };
}

export async function listCurrentChecklistProfiles(
  organizationId: string,
  client: ChecklistProfileReadClient = db,
): Promise<ChecklistProfileVersion[]> {
  const rows = await client.select().from(onbChecklistProfiles)
    .where(eq(onbChecklistProfiles.organizationId, organizationId))
    .orderBy(onbChecklistProfiles.profileId, desc(onbChecklistProfiles.version));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.profileId)) return false;
    seen.add(row.profileId);
    return true;
  });
}

export async function resolveChecklistProfile(
  organizationId: string,
  attributes: EmployeeChecklistAttributes,
) {
  return db.transaction((tx) =>
    resolveChecklistProfileInTransaction(tx, organizationId, attributes),
  );
}

export async function resolveChecklistProfileInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  attributes: EmployeeChecklistAttributes,
) {
  await acquireChecklistPolicyLock(tx, organizationId);
  return resolveFromProfiles(
    await getEffectiveChecklist(organizationId, tx),
    await listCurrentChecklistProfiles(organizationId, tx),
    attributes,
  );
}

export type ChecklistProfileInput = {
  name: string;
  criteria: OnbChecklistProfileCriteria;
  overrides: OnbChecklistItemOverride[];
  priority: number;
  enabled: boolean;
  processPolicy?: Record<string, unknown>;
};

function validateProfileInput(input: ChecklistProfileInput): ChecklistProfileInput {
  const criteria = normalizeCriteria(input.criteria);
  if (!input.name.trim() || input.name.trim().length > 120) throw new Error("Profile name must contain 1–120 characters.");
  if (Object.keys(criteria).length === 0) throw new Error("A targeted profile needs at least one criterion.");
  if (Object.values(criteria).some((value) => value.length > 120)) {
    throw new Error("Each profile criterion must contain 1–120 characters.");
  }
  if (!Number.isInteger(input.priority) || input.priority < 0) throw new Error("Priority must be a non-negative integer.");
  if (input.overrides.length > 100) throw new Error("A profile cannot contain more than 100 overrides.");
  if (input.processPolicy?.match !== undefined && !policyMatchGroup(input.processPolicy)) {
    throw new Error("Policy match must declare operator 'all' or 'any' and non-empty field/value rules.");
  }
  const ids = new Set<string>();
  for (const override of input.overrides) {
    if (ids.has(override.id)) throw new Error(`Duplicate override "${override.id}".`);
    ids.add(override.id);
  }
  return {
    ...input,
    name: input.name.trim(),
    criteria,
    // Existing published versions retain their semantics. Every new write is
    // explicit v2 additive policy behavior, including a republished legacy profile.
    processPolicy: { ...(input.processPolicy ?? {}), semanticsVersion: 2 },
  };
}

export async function saveChecklistProfile(
  organizationId: string,
  profileId: string | null,
  expectedVersion: number | null,
  rawInput: ChecklistProfileInput,
  createdBy: string,
): Promise<ChecklistProfileVersion> {
  const input = validateProfileInput(rawInput);
  return db.transaction((tx) =>
    saveChecklistProfileInTransaction(tx, organizationId, profileId, expectedVersion, input, createdBy),
  );
}

/** Shared transaction primitive for approval workflows that must publish a profile atomically. */
export async function saveChecklistProfileInTransaction(
  tx: OnboardingDbTransaction,
  organizationId: string,
  profileId: string | null,
  expectedVersion: number | null,
  rawInput: ChecklistProfileInput,
  createdBy: string,
): Promise<ChecklistProfileVersion> {
    const input = validateProfileInput(rawInput);
    await acquireChecklistPolicyLock(tx, organizationId);
    const base = await getEffectiveChecklist(organizationId, tx);
    applyChecklistOverrides(base.items, input.overrides);
    const rows = await tx.select().from(onbChecklistProfiles)
      .where(eq(onbChecklistProfiles.organizationId, organizationId))
      .orderBy(onbChecklistProfiles.profileId, desc(onbChecklistProfiles.version));
    const seen = new Set<string>();
    const current = rows.filter((row) => {
      if (seen.has(row.profileId)) return false;
      seen.add(row.profileId);
      return true;
    });
    const existing = profileId ? current.find((profile) => profile.profileId === profileId) : undefined;
    if (profileId && !existing) throw Object.assign(new Error("Checklist profile not found."), { name: "ProfileNotFound" });
    if (existing && existing.version !== expectedVersion) {
      throw Object.assign(new Error(`Profile changed since it was loaded (current version ${existing.version}).`), { name: "ProfileVersionConflict" });
    }
    if (input.enabled) {
      const ambiguous = current.find((profile) =>
        profile.profileId !== profileId && profile.enabled && profile.priority === input.priority &&
        profilesCouldOverlap(profile.criteria, profile.processPolicy, input.criteria, input.processPolicy));
      if (ambiguous) {
        throw Object.assign(new Error(`Enabled profile conflicts with "${ambiguous.name}" at priority ${input.priority}.`), { name: "ProfileAmbiguity" });
      }
    }
    const id = profileId ?? randomUUID();
    const [created] = await tx.insert(onbChecklistProfiles).values({
      organizationId,
      profileId: id,
      version: (existing?.version ?? 0) + 1,
      ...input,
      processPolicy: input.processPolicy ?? {},
      createdBy,
    }).returning();
    return created;
}

export async function disableChecklistProfile(
  organizationId: string,
  profileId: string,
  createdBy: string,
): Promise<ChecklistProfileVersion> {
  return db.transaction(async (tx) => {
    await acquireChecklistPolicyLock(tx, organizationId);
    const current = (await listCurrentChecklistProfiles(organizationId, tx))
      .find((profile) => profile.profileId === profileId);
    if (!current) {
      throw Object.assign(new Error("Checklist profile not found."), { name: "ProfileNotFound" });
    }
    if (!current.enabled) return current;
    const [disabled] = await tx.insert(onbChecklistProfiles).values({
      organizationId,
      profileId,
      version: current.version + 1,
      name: current.name,
      criteria: current.criteria,
      overrides: current.overrides,
      processPolicy: current.processPolicy,
      priority: current.priority,
      enabled: false,
      createdBy,
    }).returning();
    return disabled;
  });
}
