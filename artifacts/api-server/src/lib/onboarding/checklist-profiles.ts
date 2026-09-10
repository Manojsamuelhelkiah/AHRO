import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  onbChecklistProfiles,
  type OnbChecklistItemOverride,
  type OnbChecklistProfileCriteria,
  type OnbChecklistTemplateItem,
} from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  acquireChecklistPolicyLock,
  getEffectiveChecklist,
  type OnboardingDbTransaction,
  validateChecklist,
} from "./settings";

type ChecklistProfileReadClient = Pick<typeof db, "select">;

export type EmployeeChecklistAttributes = {
  /** A case may have no HR band; do not substitute worker category for it. */
  band: string | null;
  role: string;
  employmentType: string;
  location: string;
};

export type ChecklistProfileVersion = typeof onbChecklistProfiles.$inferSelect;

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
): boolean {
  const normalized = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, normalizeCriterion(value)]),
  ) as EmployeeChecklistAttributes;
  return Object.entries(criteria).every(([key, value]) => normalized[key as keyof EmployeeChecklistAttributes] === value);
}

/** Two conjunctions overlap unless they disagree on at least one criterion supplied by both. */
export function criteriaOverlap(a: OnbChecklistProfileCriteria, b: OnbChecklistProfileCriteria): boolean {
  return !Object.keys(a).some((key) => {
    const other = b[key as keyof OnbChecklistProfileCriteria];
    return other !== undefined && other !== a[key as keyof OnbChecklistProfileCriteria];
  });
}

export function applyChecklistOverrides(
  base: readonly OnbChecklistTemplateItem[],
  overrides: readonly OnbChecklistItemOverride[],
): OnbChecklistTemplateItem[] {
  const byId = new Map(base.map((item) => [item.id, { ...item }]));
  for (const override of overrides) {
    const current = byId.get(override.id);
    if (!current && (override.label === undefined || override.order === undefined)) {
      throw new Error(`New checklist item "${override.id}" requires label and order.`);
    }
    byId.set(override.id, {
      id: override.id,
      label: override.label ?? current!.label,
      order: override.order ?? current!.order,
      enabled: override.enabled ?? current?.enabled ?? true,
      mandatory: override.mandatory ?? current?.mandatory ?? false,
      enforcementStage: override.enforcementStage ?? current?.enforcementStage ?? "before-day1-review",
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
) {
  const prior = new Map(previous.map((item) => [item.key, item]));
  return items
    .filter((item) => item.enabled)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const old = prior.get(item.id);
      return {
        key: item.id,
        id: item.id,
        label: item.label,
        status: old?.status ?? "pending",
        ...(old?.note === undefined ? {} : { note: old.note }),
        order: item.order,
        mandatory: item.mandatory,
        enforcementStage: item.enforcementStage,
      };
    });
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

export function activeReplacementDecision(
  current: { orchestrationCheckpoint: string | null; lifecycleStage: string },
  items: readonly OnbChecklistTemplateItem[],
  readiness: readonly { key: string; status: string }[],
): { ok: true; forceReReview: boolean } | { ok: false; reason: string } {
  const readinessById = new Map(readiness.map((item) => [item.key, item.status]));
  const passedGateCount =
    current.lifecycleStage === "day1-review" || current.lifecycleStage === "completed"
      ? 3
      : current.orchestrationCheckpoint === null
        ? undefined
        : CHECKPOINT_PASSED_GATES.get(current.orchestrationCheckpoint);
  if (passedGateCount === undefined) {
    return {
      ok: false,
      reason: "This case is not paused at a recognized orchestration boundary, so its checklist cannot be replaced safely.",
    };
  }
  const unmetPassedGate = items.find((item) =>
    item.enabled &&
    item.mandatory &&
    readinessById.get(item.id) !== "ready" &&
    CHECKLIST_STAGE_ORDER.indexOf(item.enforcementStage) < passedGateCount);
  if (!unmetPassedGate) return { ok: true, forceReReview: false };
  if (passedGateCount === CHECKLIST_STAGE_ORDER.length) {
    return { ok: true, forceReReview: true };
  }
  return {
    ok: false,
    reason: `Replacement would add unmet requirement "${unmetPassedGate.label}" after its ${unmetPassedGate.enforcementStage.replace("before-", "before ")} gate has already passed.`,
  };
}

export function validateProfilesAgainstBase(
  base: { items: readonly OnbChecklistTemplateItem[] },
  profiles: readonly Pick<ChecklistProfileVersion, "name" | "overrides">[],
): void {
  for (const profile of profiles) {
    try {
      applyChecklistOverrides(base.items, profile.overrides);
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
    .filter((profile) => profile.enabled && profileMatches(profile.criteria, attributes))
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
    };
  }
  return {
    templateVersion: base.version,
    profileId: selected.profileId,
    profileName: selected.name,
    profileVersion: selected.version,
    matchedCriteria: selected.criteria,
    explanation: `Matched ${Object.entries(selected.criteria).map(([key, value]) => `${key}="${value}"`).join(" and ")}; selected priority ${selected.priority}.`,
    items: applyChecklistOverrides(base.items, selected.overrides),
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
  const ids = new Set<string>();
  for (const override of input.overrides) {
    if (ids.has(override.id)) throw new Error(`Duplicate override "${override.id}".`);
    ids.add(override.id);
  }
  return { ...input, name: input.name.trim(), criteria };
}

export async function saveChecklistProfile(
  organizationId: string,
  profileId: string | null,
  expectedVersion: number | null,
  rawInput: ChecklistProfileInput,
  createdBy: string,
): Promise<ChecklistProfileVersion> {
  const input = validateProfileInput(rawInput);
  return db.transaction(async (tx) => {
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
        criteriaOverlap(profile.criteria, input.criteria));
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
      createdBy,
    }).returning();
    return created;
  });
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
      priority: current.priority,
      enabled: false,
      createdBy,
    }).returning();
    return disabled;
  });
}