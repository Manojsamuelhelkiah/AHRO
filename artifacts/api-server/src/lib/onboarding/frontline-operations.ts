import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbCases,
  onbEvents,
  onbEmploymentOutcomeEvidence,
  onbFrontlineEvidence,
  onbFrontlineFulfillments,
  onbFrontlineKpiInputs,
  onbFrontlinePolicyExceptions,
  onbFrontlineReleaseState,
  onbSystemChecks,
  organizationMembershipsTable,
  type OnbAuthorityScope,
} from "@workspace/db";
import { hasTrustedBgvClearanceEvidence } from "./connector-evidence-provenance";
import { hasCurrentAuthorityScope, roleMayExerciseScope } from "./decision-authority";
import { reopenApprovalInTransaction } from "./approval-version";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

const FRONTLINE_POLICY_SCHEMA = "frontline-operations/v1";
const ITEMS = ["badge", "ppe", "uniform", "tool", "locker"] as const;
const EVIDENCE_KINDS = [
  "age-proof", "skill-certificate", "medical-fitness", "safety-competency",
  "wage-setup", "timesheet-setup", "statutory-registration",
] as const;
const KPI_KINDS = [
  "intake", "medical-result", "safety-completed", "ppe-issued",
  "statutory-registered", "actual-exit",
] as const;
type Item = typeof ITEMS[number];
type EvidenceKind = typeof EVIDENCE_KINDS[number];
type KpiKind = typeof KPI_KINDS[number];

export class FrontlineValidationError extends Error {
  constructor(message: string) { super(message); this.name = "FrontlineValidationError"; }
}
export class FrontlineConflictError extends Error {
  constructor(message: string) { super(message); this.name = "FrontlineConflictError"; }
}

type FrontlinePolicy = {
  minimumAgeYears: number;
  requiredFulfillment: Item[];
  statutoryRequirements: Array<{
    key: string; jurisdiction: string; effectiveFrom?: string; effectiveUntil?: string;
    policyReference: string; reviewReference: string;
  }>;
  exceptions: { policyReference: string; reviewReference: string; permitted: Array<"substitution" | "deferment"> };
};
function policyDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new FrontlineValidationError(`${field} must be a valid ISO date/time.`);
  }
  return new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new FrontlineValidationError(`${field} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}
function isoDate(value: unknown, field: string, allowFuture = false): Date {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new FrontlineValidationError(`${field} must be a valid ISO date/time.`);
  }
  const date = new Date(value);
  if (!allowFuture && date.getTime() > Date.now() + 5 * 60_000) {
    throw new FrontlineValidationError(`${field} cannot be in the future.`);
  }
  return date;
}
function kind(value: unknown): EvidenceKind {
  if (typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value)) return value as EvidenceKind;
  throw new FrontlineValidationError("A valid frontline evidence kind is required.");
}
function item(value: unknown): Item {
  if (typeof value === "string" && (ITEMS as readonly string[]).includes(value)) return value as Item;
  throw new FrontlineValidationError("A valid physical fulfillment item is required.");
}
function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new FrontlineValidationError("expectedVersion must be a non-negative integer.");
  return value as number;
}
/** Strictly parses only the immutable, reviewed policy shape. Absence is never
 * interpreted as a jurisdictional or statutory default. */
export function parseFrontlinePolicy(snapshot: Record<string, unknown>): FrontlinePolicy {
  const root = asRecord(asRecord(snapshot.processPolicy)?.frontline);
  if (!root || root.schemaVersion !== FRONTLINE_POLICY_SCHEMA) {
    throw new FrontlineValidationError("An explicit immutable frontline policy review is required before frontline evidence or release.");
  }
  const fulfillment = asRecord(root.fulfillment);
  const age = asRecord(root.age);
  const statutory = asRecord(root.statutory);
  const exceptions = asRecord(root.exceptions);
  const requiredFulfillment = fulfillment?.requiredItems;
  const statutoryRequirements = statutory?.requirements;
  const permitted = exceptions?.permitted;
  if (
    !age || !Number.isInteger(age.minimumYears) || (age.minimumYears as number) < 14 || (age.minimumYears as number) > 100 ||
    !Array.isArray(requiredFulfillment) || !requiredFulfillment.length ||
    requiredFulfillment.some((entry) => !(ITEMS as readonly string[]).includes(entry as string)) ||
    !Array.isArray(statutoryRequirements) ||
    !exceptions || !Array.isArray(permitted) ||
    permitted.some((entry) => entry !== "substitution" && entry !== "deferment")
  ) throw new FrontlineValidationError("The immutable frontline policy is incomplete; human policy review is required.");
  return {
    minimumAgeYears: age.minimumYears as number,
    requiredFulfillment: [...new Set(requiredFulfillment as Item[])],
    statutoryRequirements: statutoryRequirements.map((entry, index) => {
      const row = asRecord(entry);
      if (!row) throw new FrontlineValidationError(`frontline.statutory.requirements[${index}] must be an object.`);
      const jurisdiction = text(row.jurisdiction, `frontline.statutory.requirements[${index}].jurisdiction`, 120);
      return {
        key: text(row.key, `frontline.statutory.requirements[${index}].key`, 120),
        jurisdiction,
        ...(row.effectiveFrom === undefined ? {} : { effectiveFrom: policyDate(row.effectiveFrom, "statutory effectiveFrom") }),
        ...(row.effectiveUntil === undefined ? {} : { effectiveUntil: policyDate(row.effectiveUntil, "statutory effectiveUntil") }),
        policyReference: text(row.policyReference, "statutory policyReference"),
        reviewReference: text(row.reviewReference, "statutory reviewReference"),
      };
    }).map((requirement) => {
      if (requirement.effectiveFrom && requirement.effectiveUntil && requirement.effectiveUntil <= requirement.effectiveFrom) {
        throw new FrontlineValidationError("A statutory requirement effectiveUntil must be after effectiveFrom.");
      }
      return requirement;
    }),
    exceptions: {
      policyReference: text(exceptions.policyReference, "frontline exceptions policyReference"),
      reviewReference: text(exceptions.reviewReference, "frontline exceptions reviewReference"),
      permitted: [...new Set(permitted as Array<"substitution" | "deferment">)],
    },
  };
}
function applicableStatutoryRequirements(c: typeof onbCases.$inferSelect, policy: FrontlinePolicy, at: Date) {
  const jurisdictions = new Set([
    c.workforceContext.workCountry?.trim(),
    c.workforceContext.workState?.trim(),
  ].filter((value): value is string => Boolean(value)));
  const timestamp = at.toISOString();
  return policy.statutoryRequirements.filter((requirement) =>
    jurisdictions.has(requirement.jurisdiction) &&
    (!requirement.effectiveFrom || requirement.effectiveFrom <= timestamp) &&
    (!requirement.effectiveUntil || requirement.effectiveUntil > timestamp),
  );
}
function isFrontline(c: typeof onbCases.$inferSelect): boolean {
  const context = c.workforceContext ?? {};
  return context.workEnvironment === "site" || context.workEnvironment === "field" ||
    context.workEnvironment === "mixed" || context.siteExposure === true || context.safetyCritical === true;
}
function authorityScopeForEvidence(value: EvidenceKind): OnbAuthorityScope {
  switch (value) {
    case "medical-fitness": return "occupational-health-approve";
    case "safety-competency": return "safety-approve";
    case "wage-setup":
    case "timesheet-setup": return "payroll-approve";
    case "statutory-registration": return "legal-approve";
    default: return "hr-compliance-approve";
  }
}
async function currentAuthority(
  tx: any, c: typeof onbCases.$inferSelect, actorUserId: string, scope: OnbAuthorityScope,
) {
  if (!(await hasCurrentAuthorityScope(tx, { organizationId: c.organizationId, actorUserId, scope, caseId: c.id }))) {
    throw new FrontlineValidationError("A current governance-approved, scoped authority is required for this frontline action.");
  }
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, c.organizationId),
    eq(onbAuthorityAssignments.personUserId, actorUserId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
  )).for("update");
  const authority = rows.find((row: typeof onbAuthorityAssignments.$inferSelect) =>
    row.scopes.includes(scope) && roleMayExerciseScope(row.authorityRole, scope) &&
    (row.caseId === null || row.caseId === c.id) &&
    (!row.siteScope || row.siteScope === c.geography) &&
    (!row.jurisdictionScope || row.jurisdictionScope === c.legalEntity),
  );
  if (!authority) throw new FrontlineValidationError("A current exact authority binding is required for this frontline action.");
  return authority;
}
async function authorityStillLive(
  tx: any, c: typeof onbCases.$inferSelect, binding: {
    authorityScope: OnbAuthorityScope; authorityAssignmentId: string; authorityAssignmentRevision: number; recordedByUserId: string;
  },
): Promise<boolean> {
  const now = new Date();
  const [governance, authority, membership] = await Promise.all([
    tx.select({ status: onbAuthorityGovernance.status }).from(onbAuthorityGovernance)
      .where(eq(onbAuthorityGovernance.organizationId, c.organizationId)),
    tx.select().from(onbAuthorityAssignments).where(and(
      eq(onbAuthorityAssignments.organizationId, c.organizationId),
      eq(onbAuthorityAssignments.id, binding.authorityAssignmentId),
      eq(onbAuthorityAssignments.revision, binding.authorityAssignmentRevision),
      eq(onbAuthorityAssignments.personUserId, binding.recordedByUserId),
      eq(onbAuthorityAssignments.status, "active"),
      lte(onbAuthorityAssignments.validFrom, now),
      or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
    )),
    tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, c.organizationId),
      eq(organizationMembershipsTable.clerkUserId, binding.recordedByUserId),
      isNull(organizationMembershipsTable.revokedAt),
    )),
  ]);
  const row = authority[0];
  return governance[0]?.status === "governance-approved" && Boolean(membership[0]) && Boolean(row) &&
    row!.scopes.includes(binding.authorityScope) &&
    roleMayExerciseScope(row!.authorityRole, binding.authorityScope) &&
    (row!.caseId === null || row!.caseId === c.id) &&
    (!row!.siteScope || row!.siteScope === c.geography) &&
    (!row!.jurisdictionScope || row!.jurisdictionScope === c.legalEntity);
}
async function lockedState(tx: any, organizationId: string, caseId: number) {
  const [state] = await tx.select().from(onbFrontlineReleaseState).where(and(
    eq(onbFrontlineReleaseState.organizationId, organizationId), eq(onbFrontlineReleaseState.caseId, caseId),
  )).for("update");
  return state;
}
async function bumpState(tx: any, c: typeof onbCases.$inferSelect, state: typeof onbFrontlineReleaseState.$inferSelect | undefined, patch: Partial<typeof onbFrontlineReleaseState.$inferInsert> = {}) {
  const version = (state?.version ?? 0) + 1;
  if (!state) {
    await tx.insert(onbFrontlineReleaseState).values({
      organizationId: c.organizationId, caseId: c.id, version, status: "not-released", ...patch,
    });
  } else {
    await tx.update(onbFrontlineReleaseState).set({ version, updatedAt: new Date(), ...patch }).where(and(
      eq(onbFrontlineReleaseState.organizationId, c.organizationId), eq(onbFrontlineReleaseState.caseId, c.id),
      eq(onbFrontlineReleaseState.version, state.version),
    ));
  }
  return version;
}
function assertVersion(state: typeof onbFrontlineReleaseState.$inferSelect | undefined, requested: number) {
  if ((state?.version ?? 0) !== requested) {
    throw new FrontlineConflictError(`Frontline state changed since it was loaded (current version ${state?.version ?? 0}).`);
  }
}
function publicFulfillment(row: typeof onbFrontlineFulfillments.$inferSelect) {
  return {
    item: row.item, requestedQuantity: row.requestedQuantity, issuedQuantity: row.issuedQuantity,
    sizeRecorded: row.size !== null, status: row.status, issuerTimestamp: row.issuerTimestamp.toISOString(),
    acknowledged: row.acknowledgedAt !== null,
  };
}

export async function recordFrontlineEvidence(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number; kind: EvidenceKind;
  evidenceReference: string; issuerTimestamp: string; effectiveAt?: string; expiresAt?: string;
  statutoryKey?: string; status?: "verified" | "rejected" | "revoked"; revocationReference?: string;
  skillRequirementKey?: string; subjectAgeYears?: number;
}): Promise<{ version: number }> {
  const inputKind = kind(input.kind);
  const evidenceReference = text(input.evidenceReference, "evidenceReference");
  const issuerTimestamp = isoDate(input.issuerTimestamp, "issuerTimestamp");
  const effectiveAt = input.effectiveAt ? isoDate(input.effectiveAt, "effectiveAt") : issuerTimestamp;
  const expiresAt = input.expiresAt ? isoDate(input.expiresAt, "expiresAt", true) : null;
  if (expiresAt && expiresAt <= effectiveAt) throw new FrontlineValidationError("expiresAt must be after effectiveAt.");
  const status = input.status ?? "verified";
  if (!["verified", "rejected"].includes(status)) throw new FrontlineValidationError("Evidence recording accepts only verified or rejected status; revocation must name an existing evidence id.");
  if (input.revocationReference !== undefined) throw new FrontlineValidationError("revocationReference is accepted only by the server-side evidence revocation endpoint.");
  const revocationReference = null;
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    const policy = parseFrontlinePolicy(c.processPolicySnapshot ?? {});
    const scope = authorityScopeForEvidence(inputKind);
    const authority = await currentAuthority(tx, c, input.actorUserId, scope);
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    let statutoryKey: string | null = null;
    let skillRequirementKey: string | null = null;
    let subjectAgeYears: number | null = null;
    if (inputKind === "statutory-registration") {
      statutoryKey = text(input.statutoryKey, "statutoryKey", 120);
      const requirement = applicableStatutoryRequirements(c, policy, effectiveAt).find((entry) => entry.key === statutoryKey);
      if (!requirement) throw new FrontlineValidationError("Statutory evidence requires an explicit jurisdiction-reviewed requirement in the immutable frontline policy.");
    } else if (input.statutoryKey !== undefined) {
      throw new FrontlineValidationError("statutoryKey is permitted only for statutory-registration evidence.");
    }
    if (inputKind === "skill-certificate") {
      skillRequirementKey = text(input.skillRequirementKey, "skillRequirementKey", 120);
      if (!c.workforceContext.requiredLicenses?.includes(skillRequirementKey)) {
        throw new FrontlineValidationError("Skill evidence must match an applicable policy-established required license.");
      }
    } else if (input.skillRequirementKey !== undefined) {
      throw new FrontlineValidationError("skillRequirementKey is permitted only for skill-certificate evidence.");
    }
    if (inputKind === "age-proof") {
      if (!Number.isInteger(input.subjectAgeYears) || input.subjectAgeYears! < policy.minimumAgeYears || input.subjectAgeYears! > 120) {
        throw new FrontlineValidationError(`Age proof must establish an age of at least the explicit policy minimum (${policy.minimumAgeYears}).`);
      }
      subjectAgeYears = input.subjectAgeYears!;
    } else if (input.subjectAgeYears !== undefined) {
      throw new FrontlineValidationError("subjectAgeYears is permitted only for age-proof evidence.");
    }
    await tx.insert(onbFrontlineEvidence).values({
      organizationId: input.organizationId, caseId: input.caseId, kind: inputKind, statutoryKey, skillRequirementKey, subjectAgeYears,
      evidenceReference, issuerTimestamp, effectiveAt, expiresAt, status, authorityScope: scope,
      authorityAssignmentId: authority.id, authorityAssignmentRevision: authority.revision,
      recordedByUserId: input.actorUserId, revocationReference,
    });
    const version = await bumpState(tx, c, state);
    return { version };
  }));
}

export async function revokeFrontlineEvidence(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number;
  evidenceId: number; revocationReference: string;
}): Promise<{ version: number }> {
  if (!Number.isInteger(input.evidenceId) || input.evidenceId < 1) throw new FrontlineValidationError("evidenceId must be a positive integer.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    const [evidence] = await tx.select().from(onbFrontlineEvidence).where(and(
      eq(onbFrontlineEvidence.organizationId, input.organizationId), eq(onbFrontlineEvidence.caseId, input.caseId),
      eq(onbFrontlineEvidence.id, input.evidenceId),
    )).for("update");
    if (!evidence) throw new FrontlineValidationError("Evidence not found.");
    await currentAuthority(tx, c, input.actorUserId, authorityScopeForEvidence(evidence.kind));
    if (evidence.status === "revoked") throw new FrontlineConflictError("Evidence is already revoked.");
    await tx.update(onbFrontlineEvidence).set({
      status: "revoked", revocationReference: text(input.revocationReference, "revocationReference"),
    }).where(and(eq(onbFrontlineEvidence.organizationId, input.organizationId), eq(onbFrontlineEvidence.id, evidence.id)));
    return { version: await bumpState(tx, c, state) };
  }));
}

export async function recordFrontlinePolicyException(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number; item: Item;
  type: "substitution" | "deferment"; reviewReference: string; effectiveAt: string; expiresAt?: string;
}): Promise<{ exceptionId: number; version: number }> {
  const exceptionItem = item(input.item);
  if (input.type !== "substitution" && input.type !== "deferment") throw new FrontlineValidationError("Exception type must be substitution or deferment.");
  const effectiveAt = isoDate(input.effectiveAt, "effectiveAt");
  const expiresAt = input.expiresAt ? isoDate(input.expiresAt, "expiresAt", true) : null;
  if (expiresAt && expiresAt <= effectiveAt) throw new FrontlineValidationError("expiresAt must be after effectiveAt.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    const policy = parseFrontlinePolicy(c.processPolicySnapshot ?? {});
    if (!policy.requiredFulfillment.includes(exceptionItem) || !policy.exceptions.permitted.includes(input.type)) {
      throw new FrontlineValidationError("This substitution/deferment is not explicitly permitted by the immutable frontline policy.");
    }
    const authority = await currentAuthority(tx, c, input.actorUserId, "safety-approve");
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    const [created] = await tx.insert(onbFrontlinePolicyExceptions).values({
      organizationId: input.organizationId, caseId: input.caseId, item: exceptionItem, type: input.type,
      policyReference: policy.exceptions.policyReference, reviewReference: text(input.reviewReference, "reviewReference"),
      effectiveAt, expiresAt, authorityAssignmentId: authority.id, authorityAssignmentRevision: authority.revision,
      reviewedByUserId: input.actorUserId,
    }).returning({ id: onbFrontlinePolicyExceptions.id });
    const version = await bumpState(tx, c, state);
    return { exceptionId: created!.id, version };
  }));
}

/** Revocation is a server-recorded, authenticated safety decision; a client cannot
 * make a remote provider/reviewer revocation claim. */
export async function revokeFrontlinePolicyException(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number;
  exceptionId: number; revocationReference: string;
}): Promise<{ version: number }> {
  if (!Number.isInteger(input.exceptionId) || input.exceptionId < 1) throw new FrontlineValidationError("exceptionId must be a positive integer.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    parseFrontlinePolicy(c.processPolicySnapshot ?? {});
    await currentAuthority(tx, c, input.actorUserId, "safety-approve");
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    const [exception] = await tx.select().from(onbFrontlinePolicyExceptions).where(and(
      eq(onbFrontlinePolicyExceptions.organizationId, input.organizationId),
      eq(onbFrontlinePolicyExceptions.caseId, input.caseId),
      eq(onbFrontlinePolicyExceptions.id, input.exceptionId),
    )).for("update");
    if (!exception) throw new FrontlineValidationError("Policy exception not found.");
    if (exception.revokedAt) throw new FrontlineConflictError("Policy exception is already revoked.");
    await tx.update(onbFrontlinePolicyExceptions).set({
      revokedAt: new Date(), revocationReference: text(input.revocationReference, "revocationReference"),
    }).where(and(eq(onbFrontlinePolicyExceptions.organizationId, input.organizationId), eq(onbFrontlinePolicyExceptions.id, input.exceptionId)));
    const version = await bumpState(tx, c, state);
    return { version };
  }));
}

export async function recordFrontlineFulfillment(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number; item: Item;
  assetReference: string; size?: string; requestedQuantity: number; issuedQuantity: number;
  issuerTimestamp: string; acknowledgedAt?: string; status?: "issued" | "shortage" | "substituted" | "deferred"; exceptionId?: number;
  acknowledgementRecipientReference?: string; acknowledgementMethod?: "in-person" | "signed-receipt" | "verified-digital";
}): Promise<{ version: number }> {
  const fulfillmentItem = item(input.item);
  if (!Number.isInteger(input.requestedQuantity) || input.requestedQuantity < 1 ||
    !Number.isInteger(input.issuedQuantity) || input.issuedQuantity < 0 || input.issuedQuantity > input.requestedQuantity) {
    throw new FrontlineValidationError("requestedQuantity must be positive and issuedQuantity must be between zero and requestedQuantity.");
  }
  const status = input.status ?? (input.issuedQuantity === input.requestedQuantity ? "issued" : "shortage");
  if (!["issued", "shortage", "substituted", "deferred"].includes(status)) throw new FrontlineValidationError("Fulfillment status is invalid.");
  if ((status === "shortage") !== (input.issuedQuantity < input.requestedQuantity)) {
    throw new FrontlineValidationError("A shortage status must exactly reflect issuedQuantity being below requestedQuantity.");
  }
  if ((status === "substituted" || status === "deferred") && !Number.isInteger(input.exceptionId)) {
    throw new FrontlineValidationError("Substitution or deferment requires an explicit policy-reviewed exception.");
  }
  if ((status === "issued" || status === "shortage") && input.exceptionId !== undefined) {
    throw new FrontlineValidationError("exceptionId is permitted only for substitution or deferment.");
  }
  const issuerTimestamp = isoDate(input.issuerTimestamp, "issuerTimestamp");
  const acknowledgedAt = input.acknowledgedAt ? isoDate(input.acknowledgedAt, "acknowledgedAt") : null;
  if (acknowledgedAt && acknowledgedAt < issuerTimestamp) throw new FrontlineValidationError("acknowledgedAt cannot precede issuerTimestamp.");
  if (Boolean(acknowledgedAt) !== Boolean(input.acknowledgementRecipientReference) ||
    Boolean(acknowledgedAt) !== Boolean(input.acknowledgementMethod) ||
    (input.acknowledgementMethod !== undefined && !["in-person", "signed-receipt", "verified-digital"].includes(input.acknowledgementMethod))) {
    throw new FrontlineValidationError("An acknowledgement requires timestamp, recipient reference, and accountable method together.");
  }
  if ((fulfillmentItem === "ppe" || fulfillmentItem === "uniform") && !input.size?.trim()) {
    throw new FrontlineValidationError(`size is required for ${fulfillmentItem} fulfillment.`);
  }
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    const policy = parseFrontlinePolicy(c.processPolicySnapshot ?? {});
    if (!policy.requiredFulfillment.includes(fulfillmentItem)) throw new FrontlineValidationError("This physical item is not in the immutable frontline policy.");
    const authority = await currentAuthority(tx, c, input.actorUserId, "site-fulfillment-approve");
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    if (input.exceptionId !== undefined) {
      const [exception] = await tx.select().from(onbFrontlinePolicyExceptions).where(and(
        eq(onbFrontlinePolicyExceptions.organizationId, input.organizationId),
        eq(onbFrontlinePolicyExceptions.caseId, input.caseId), eq(onbFrontlinePolicyExceptions.id, input.exceptionId),
        eq(onbFrontlinePolicyExceptions.item, fulfillmentItem), eq(onbFrontlinePolicyExceptions.type, status === "substituted" ? "substitution" : "deferment"),
        isNull(onbFrontlinePolicyExceptions.revokedAt), lte(onbFrontlinePolicyExceptions.effectiveAt, new Date()),
        or(isNull(onbFrontlinePolicyExceptions.expiresAt), gt(onbFrontlinePolicyExceptions.expiresAt, new Date())),
      )).for("update");
      if (!exception || !(await authorityStillLive(tx, c, {
        authorityScope: "safety-approve", authorityAssignmentId: exception.authorityAssignmentId,
        authorityAssignmentRevision: exception.authorityAssignmentRevision, recordedByUserId: exception.reviewedByUserId,
      }))) throw new FrontlineValidationError("The requested substitution/deferment has no current live policy-review authority.");
    }
    const [last] = await tx.select({ revision: onbFrontlineFulfillments.revision }).from(onbFrontlineFulfillments).where(and(
      eq(onbFrontlineFulfillments.organizationId, input.organizationId), eq(onbFrontlineFulfillments.caseId, input.caseId),
      eq(onbFrontlineFulfillments.item, fulfillmentItem),
    )).orderBy(desc(onbFrontlineFulfillments.revision)).limit(1).for("update");
    await tx.insert(onbFrontlineFulfillments).values({
      organizationId: input.organizationId, caseId: input.caseId, item: fulfillmentItem, revision: (last?.revision ?? 0) + 1,
      assetReference: text(input.assetReference, "assetReference"), size: input.size === undefined ? null : text(input.size, "size", 120),
      requestedQuantity: input.requestedQuantity, issuedQuantity: input.issuedQuantity, issuerTimestamp, acknowledgedAt,
      status, exceptionId: input.exceptionId ?? null, issuedByUserId: authority.personUserId,
      acknowledgementRecipientReference: input.acknowledgementRecipientReference === undefined ? null : text(input.acknowledgementRecipientReference, "acknowledgementRecipientReference"),
      acknowledgementMethod: input.acknowledgementMethod ?? null,
      policySnapshotReference: `${c.checklistProfileId ?? "case"}:v${c.checklistProfileVersion ?? 0}:frontline-operations/v1`,
    });
    const version = await bumpState(tx, c, state);
    return { version };
  }));
}

export async function recordFrontlineKpiInput(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number; kind: KpiKind;
  occurredAt: string; actualExitAt?: string; evidenceReference: string;
}): Promise<{ inputId: number; version: number }> {
  if (typeof input.kind !== "string" || !(KPI_KINDS as readonly string[]).includes(input.kind)) throw new FrontlineValidationError("A valid frontline KPI input kind is required.");
  const occurredAt = isoDate(input.occurredAt, "occurredAt");
  const actualExitAt = input.actualExitAt ? isoDate(input.actualExitAt, "actualExitAt") : null;
  if ((input.kind === "actual-exit") !== Boolean(actualExitAt)) throw new FrontlineValidationError("actualExitAt is required only for actual-exit KPI input.");
  if (actualExitAt && actualExitAt.getTime() !== occurredAt.getTime()) throw new FrontlineValidationError("actualExitAt must equal the dated actual-exit occurrence.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    parseFrontlinePolicy(c.processPolicySnapshot ?? {});
    const scope: OnbAuthorityScope = input.kind === "intake" || input.kind === "actual-exit"
      ? "hr-compliance-approve"
      : input.kind === "medical-result"
        ? "occupational-health-approve"
        : input.kind === "statutory-registered"
          ? "legal-approve"
          : "safety-approve";
    const authority = await currentAuthority(tx, c, input.actorUserId, scope);
    if (input.kind === "actual-exit") {
      const anchors = await tx.select({
        actualJoinedAt: onbEmploymentOutcomeEvidence.actualJoinedAt,
        employmentStatus: onbEmploymentOutcomeEvidence.employmentStatus,
      }).from(onbEmploymentOutcomeEvidence).where(and(
        eq(onbEmploymentOutcomeEvidence.organizationId, input.organizationId),
        eq(onbEmploymentOutcomeEvidence.caseId, input.caseId),
        inArray(onbEmploymentOutcomeEvidence.employmentStatus, ["active", "terminated"]),
        lte(onbEmploymentOutcomeEvidence.actualJoinedAt, actualExitAt!),
      )).limit(1);
      if (!anchors[0]) {
        throw new FrontlineValidationError("A dated, authoritative actual joining record no later than actualExitAt is required before recording an actual-exit KPI input.");
      }
    }
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    const [created] = await tx.insert(onbFrontlineKpiInputs).values({
      organizationId: input.organizationId, caseId: input.caseId, kind: input.kind, occurredAt, actualExitAt,
      evidenceReference: text(input.evidenceReference, "evidenceReference"), authorityAssignmentId: authority.id,
      authorityAssignmentRevision: authority.revision, recordedByUserId: input.actorUserId,
    }).returning({ id: onbFrontlineKpiInputs.id });
    const version = await bumpState(tx, c, state);
    return { inputId: created!.id, version };
  }));
}

/** Minimal aggregate only: source references and individual exit dates stay in
 * the restricted input table. Existing outcome reporting remains the system of
 * record for attrition calculations. */
export async function getFrontlineKpiAggregate(input: { organizationId: string; caseId: number; actorUserId: string }) {
  const [c] = await db.select().from(onbCases).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)));
  if (!c) throw new FrontlineValidationError("Case not found.");
  await db.transaction((tx) => currentAuthority(tx, c, input.actorUserId, "hr-compliance-approve"));
  const { organizationId, caseId } = input;
  const [rows, release, outcomes, fulfillments, evidence] = await Promise.all([
    db.select({ kind: onbFrontlineKpiInputs.kind, occurredAt: onbFrontlineKpiInputs.occurredAt })
      .from(onbFrontlineKpiInputs).where(and(eq(onbFrontlineKpiInputs.organizationId, organizationId), eq(onbFrontlineKpiInputs.caseId, caseId))),
    db.select().from(onbFrontlineReleaseState).where(and(eq(onbFrontlineReleaseState.organizationId, organizationId), eq(onbFrontlineReleaseState.caseId, caseId))),
    db.select().from(onbEmploymentOutcomeEvidence).where(and(eq(onbEmploymentOutcomeEvidence.organizationId, organizationId), eq(onbEmploymentOutcomeEvidence.caseId, caseId))).orderBy(desc(onbEmploymentOutcomeEvidence.observedAt)),
    db.select().from(onbFrontlineFulfillments).where(and(eq(onbFrontlineFulfillments.organizationId, organizationId), eq(onbFrontlineFulfillments.caseId, caseId))).orderBy(desc(onbFrontlineFulfillments.revision)),
    db.select().from(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, organizationId), eq(onbFrontlineEvidence.caseId, caseId))).orderBy(desc(onbFrontlineEvidence.createdAt)),
  ]);
  const byKind = new Map<string, Date[]>();
  for (const row of rows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row.occurredAt]);
  const first = (kind: KpiKind) => byKind.get(kind)?.reduce((oldest, value) => value < oldest ? value : oldest);
  const duration = (from: Date | undefined, to: Date | null | undefined) =>
    from && to && to >= from ? Math.round((to.getTime() - from.getTime()) / 1_000) : null;
  const latestFulfillment = new Map<string, typeof fulfillments[number]>();
  for (const row of fulfillments) if (!latestFulfillment.has(row.item)) latestFulfillment.set(row.item, row);
  const ppe = latestFulfillment.get("ppe");
  const currentEvidence = new Map<string, typeof evidence[number]>();
  for (const row of evidence) {
    const key = `${row.kind}:${row.statutoryKey ?? row.skillRequirementKey ?? ""}`;
    if (!currentEvidence.has(key)) currentEvidence.set(key, row);
  }
  const authoritativeOutcomes = outcomes.filter((row) => row.employmentStatus === "active" || row.employmentStatus === "terminated");
  const actualJoinedAt = authoritativeOutcomes[0]?.actualJoinedAt;
  const terminated = authoritativeOutcomes.find((row) => row.employmentStatus === "terminated" && row.effectiveAt && actualJoinedAt && row.actualJoinedAt.getTime() === actualJoinedAt.getTime() && row.effectiveAt >= actualJoinedAt);
  const activeAfterThirtyDays = outcomes.find((row) =>
    row.employmentStatus === "active" && actualJoinedAt && row.actualJoinedAt.getTime() === actualJoinedAt.getTime() && row.observedAt >= new Date(actualJoinedAt.getTime() + 30 * 86_400_000),
  );
  const pendingReviewTargets: string[] = [];
  const intakeAt = first("intake");
  const medicalAt = first("medical-result");
  const safetyAt = first("safety-completed");
  const statutoryAt = first("statutory-registered");
  const ppeAt = first("ppe-issued");
  const releasedAt = release[0]?.status === "released" ? release[0].releasedAt : null;
  if (!intakeAt || !releasedAt) pendingReviewTargets.push("floor-ready-cycle-time requires dated intake and an actual dedicated floor-release decision.");
  if (!intakeAt || !medicalAt) pendingReviewTargets.push("medical-turnaround requires dated intake and medical-result inputs.");
  if (!safetyAt) pendingReviewTargets.push("safety-induction completion requires a dated safety-completed input.");
  if (!ppeAt || !ppe || ppe.issuedQuantity !== ppe.requestedQuantity || !ppe.acknowledgedAt) pendingReviewTargets.push("PPE issuance compliance requires dated complete acknowledged PPE issuance.");
  if (!statutoryAt || ![...currentEvidence.values()].some((row) => row.kind === "statutory-registration" && row.status === "verified")) pendingReviewTargets.push("statutory registration timeliness requires dated jurisdiction-reviewed registration evidence.");
  let attrition: { state: "observed"; exitedWithin30Days: boolean } | { state: "pending-review" };
  if (!actualJoinedAt) {
    pendingReviewTargets.push("0-30 day attrition requires an authoritative actual joining anchor.");
    attrition = { state: "pending-review" };
  } else if (terminated?.effectiveAt) {
    attrition = { state: "observed", exitedWithin30Days: terminated.effectiveAt <= new Date(actualJoinedAt.getTime() + 30 * 86_400_000) };
  } else if (activeAfterThirtyDays) {
    attrition = { state: "observed", exitedWithin30Days: false };
  } else {
    pendingReviewTargets.push("0-30 day attrition awaits either an actual exit or an authoritative active observation after day 30.");
    attrition = { state: "pending-review" };
  }
  return {
      caseId,
    metrics: {
      floorReadyCycleSeconds: duration(intakeAt, releasedAt),
      medicalTurnaroundSeconds: duration(intakeAt, medicalAt),
      safetyInductionCompleted: Boolean(safetyAt),
      ppeIssuanceCompliant: Boolean(ppeAt && ppe && ppe.issuedQuantity === ppe.requestedQuantity && ppe.acknowledgedAt),
      statutoryRegistrationRecorded: Boolean(statutoryAt && [...currentEvidence.values()].some((row) => row.kind === "statutory-registration" && row.status === "verified")),
      attrition0To30Days: attrition,
    },
    pendingReviewTargets,
    inputs: [...byKind.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([kind, dates]) => ({
      kind, count: dates.length,
      firstObservedAt: new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString(),
      lastObservedAt: new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString(),
    })),
  };
}

async function evaluateRelease(tx: any, c: typeof onbCases.$inferSelect) {
  const blockers: string[] = [];
  let policy: FrontlinePolicy | null = null;
  try { policy = parseFrontlinePolicy(c.processPolicySnapshot ?? {}); } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Frontline policy review is required.");
  }
  if (!isFrontline(c)) blockers.push("Frontline/site applicability has not been established.");
  if (!policy || blockers.length) return { blockers, fulfillment: [] as ReturnType<typeof publicFulfillment>[] };
  const [evidence, fulfillments, bgv] = await Promise.all([
    tx.select().from(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, c.organizationId), eq(onbFrontlineEvidence.caseId, c.id))).orderBy(desc(onbFrontlineEvidence.createdAt)),
    tx.select().from(onbFrontlineFulfillments).where(and(eq(onbFrontlineFulfillments.organizationId, c.organizationId), eq(onbFrontlineFulfillments.caseId, c.id))).orderBy(desc(onbFrontlineFulfillments.revision)),
    tx.select().from(onbSystemChecks).where(and(eq(onbSystemChecks.organizationId, c.organizationId), eq(onbSystemChecks.caseId, c.id), eq(onbSystemChecks.system, "bgv"))),
  ]);
  if (!hasTrustedBgvClearanceEvidence(bgv)) blockers.push("A current trusted BGV clearance is required for floor release.");
  const latest = new Map<string, typeof evidence[number]>();
  for (const row of evidence) {
    const key = `${row.kind}:${row.statutoryKey ?? row.skillRequirementKey ?? ""}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const now = new Date();
  const required: Array<{ kind: EvidenceKind; statutoryKey?: string; skillRequirementKey?: string }> = [
    { kind: "age-proof" }, { kind: "medical-fitness" }, { kind: "safety-competency" },
    { kind: "wage-setup" }, { kind: "timesheet-setup" },
    ...(c.workforceContext.requiredLicenses?.map((skillRequirementKey) => ({ kind: "skill-certificate" as const, skillRequirementKey })) ?? []),
    ...applicableStatutoryRequirements(c, policy, now).map((requirement) => ({ kind: "statutory-registration" as const, statutoryKey: requirement.key })),
  ];
  const medical = latest.get("medical-fitness:");
  const safety = latest.get("safety-competency:");
  for (const requirement of required) {
    const requirementKey = requirement.statutoryKey ?? requirement.skillRequirementKey ?? "";
    const row = latest.get(`${requirement.kind}:${requirementKey}`);
    if (!row || row.status !== "verified" || row.effectiveAt > now || (row.expiresAt && row.expiresAt <= now) ||
      !(await authorityStillLive(tx, c, row))) {
      blockers.push(`Current independently authorized ${requirement.kind}${requirementKey ? ` (${requirementKey})` : ""} evidence is required.`);
    }
  }
  if (medical && safety && (medical.authorityAssignmentId === safety.authorityAssignmentId || medical.recordedByUserId === safety.recordedByUserId)) {
    blockers.push("Medical fitness and safety competency require independent authority decisions.");
  }
  const latestFulfillment = new Map<Item, typeof fulfillments[number]>();
  for (const row of fulfillments) if (!latestFulfillment.has(row.item)) latestFulfillment.set(row.item, row);
  for (const requiredItem of policy.requiredFulfillment) {
    const row = latestFulfillment.get(requiredItem);
    if (!row || row.status === "shortage" || !row.acknowledgedAt ||
      !row.acknowledgementRecipientReference || !row.acknowledgementMethod || !row.policySnapshotReference ||
      (row.status === "deferred")) {
      blockers.push(`Physical ${requiredItem} issuance, policy stamp, accountable acknowledgement, and no shortage/deferment are required for floor release.`);
    }
    if (row?.status === "substituted") {
      // Its exception was validated at write time, but a live release must also
      // re-evaluate the policy authority; never reuse an old safety review.
      const [exception] = row.exceptionId === null ? [] : await tx.select().from(onbFrontlinePolicyExceptions).where(and(
        eq(onbFrontlinePolicyExceptions.organizationId, c.organizationId), eq(onbFrontlinePolicyExceptions.id, row.exceptionId),
        eq(onbFrontlinePolicyExceptions.caseId, c.id), isNull(onbFrontlinePolicyExceptions.revokedAt),
        lte(onbFrontlinePolicyExceptions.effectiveAt, now),
        or(isNull(onbFrontlinePolicyExceptions.expiresAt), gt(onbFrontlinePolicyExceptions.expiresAt, now)),
      ));
      if (!exception || !(await authorityStillLive(tx, c, {
        authorityScope: "safety-approve", authorityAssignmentId: exception.authorityAssignmentId,
        authorityAssignmentRevision: exception.authorityAssignmentRevision, recordedByUserId: exception.reviewedByUserId,
      }))) blockers.push(`Physical ${requiredItem} substitution lacks current explicit policy review.`);
    }
  }
  return { blockers, fulfillment: [...latestFulfillment.values()].map(publicFulfillment) };
}

/** Canonical, transaction-local frontline boundary used by Gate C and the
 * operations projection. It has no actor and cannot mark a case released. */
export async function evaluateFrontlineFloorReadinessInTransaction(
  tx: any,
  c: typeof onbCases.$inferSelect,
): Promise<{ applicable: boolean; blockers: string[] }> {
  if (!isFrontline(c)) return { applicable: false, blockers: [] };
  const result = await evaluateRelease(tx, c);
  return { applicable: true, blockers: result.blockers };
}

/** Heartbeat path: live authority/expiry re-evaluation for cases already
 * released to the floor. It only reblocks/reopens; it can never release. */
export async function runFrontlineReleaseHeartbeat(): Promise<void> {
  const released = await db.select({ organizationId: onbFrontlineReleaseState.organizationId, caseId: onbFrontlineReleaseState.caseId })
    .from(onbFrontlineReleaseState).where(eq(onbFrontlineReleaseState.status, "released"));
  for (const candidate of released) {
    await withSensitiveLifecycleFence(candidate.organizationId, () => db.transaction(async (tx) => {
      const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, candidate.organizationId), eq(onbCases.id, candidate.caseId))).for("update");
      if (!c) return;
      const state = await lockedState(tx, candidate.organizationId, candidate.caseId);
      if (state?.status !== "released") return;
      const live = await evaluateFrontlineFloorReadinessInTransaction(tx, c);
      if (!live.applicable || live.blockers.length === 0) return;
      await reopenApprovalInTransaction(tx, {
        organizationId: c.organizationId, caseId: c.id, idempotencyKey: `gateway-c:${c.id}:human-queue`,
        reason: `Frontline heartbeat found expired, revoked, or incomplete live release evidence: ${live.blockers.join(" ")}`,
        actor: "frontline-release-heartbeat",
      });
      await tx.update(onbCases).set({
        lifecycleStage: "preboarding", orchestrationStatus: "checklist-blocked",
        orchestrationCheckpoint: "blocked:frontline-live-review",
        orchestrationClaimOwner: null, orchestrationClaimUntil: null, updatedAt: new Date(),
      }).where(and(eq(onbCases.organizationId, c.organizationId), eq(onbCases.id, c.id)));
      await tx.update(onbFrontlineReleaseState).set({ status: "blocked", reblockedAt: new Date(), updatedAt: new Date(), version: state.version + 1 })
        .where(and(eq(onbFrontlineReleaseState.organizationId, c.organizationId), eq(onbFrontlineReleaseState.caseId, c.id), eq(onbFrontlineReleaseState.version, state.version)));
    }));
  }
}

export async function getFrontlineReadiness(organizationId: string, caseId: number) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId)));
    if (!c) throw new FrontlineValidationError("Case not found.");
    const [state] = await tx.select().from(onbFrontlineReleaseState).where(and(eq(onbFrontlineReleaseState.organizationId, organizationId), eq(onbFrontlineReleaseState.caseId, caseId)));
    const release = await evaluateRelease(tx, c);
    const evidence = await tx.select({
      kind: onbFrontlineEvidence.kind, statutoryKey: onbFrontlineEvidence.statutoryKey,
      skillRequirementKey: onbFrontlineEvidence.skillRequirementKey, status: onbFrontlineEvidence.status,
      expiresAt: onbFrontlineEvidence.expiresAt, createdAt: onbFrontlineEvidence.createdAt,
    }).from(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, organizationId), eq(onbFrontlineEvidence.caseId, caseId))).orderBy(desc(onbFrontlineEvidence.createdAt));
    const latestEvidence = new Map<string, typeof evidence[number]>();
    for (const row of evidence) {
      const key = `${row.kind}:${row.statutoryKey ?? row.skillRequirementKey ?? ""}`;
      if (!latestEvidence.has(key)) latestEvidence.set(key, row);
    }
    return {
      caseId, applicable: isFrontline(c), version: state?.version ?? 0,
      release: { eligible: release.blockers.length === 0, recorded: state?.status === "released", blockers: release.blockers, reblocked: state?.status === "blocked" },
      fulfillments: release.fulfillment,
      evidenceStatuses: [...latestEvidence.values()].map((e) => ({
        kind: e.kind,
        ...(e.statutoryKey ? { statutoryKey: e.statutoryKey } : {}),
        ...(e.skillRequirementKey ? { skillRequirementKey: e.skillRequirementKey } : {}),
        status: e.status,
        expiryState: e.expiresAt && e.expiresAt <= new Date() ? "expired" : e.expiresAt ? "current-with-expiry" : "no-expiry-recorded",
      })),
    };
  });
}

/** Restricted operational history has durable IDs for an authorized reviewer
 * to revoke a specific fact, but never exposes evidence/asset/recipient refs. */
export async function getFrontlineEvidenceHistory(input: { organizationId: string; caseId: number; actorUserId: string }) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)));
    if (!c) throw new FrontlineValidationError("Case not found.");
    const evidenceScopes: OnbAuthorityScope[] = [
      "hr-compliance-approve", "occupational-health-approve", "safety-approve",
      "payroll-approve", "legal-approve",
    ];
    const allowedScopes = new Set<OnbAuthorityScope>();
    for (const scope of evidenceScopes) {
      if (await hasCurrentAuthorityScope(tx, {
        organizationId: c.organizationId, caseId: c.id, actorUserId: input.actorUserId, scope,
      })) allowedScopes.add(scope);
    }
    const canSeeExceptions = allowedScopes.has("safety-approve") || await hasCurrentAuthorityScope(tx, {
      organizationId: c.organizationId, caseId: c.id, actorUserId: input.actorUserId, scope: "site-fulfillment-approve",
    });
    if (allowedScopes.size === 0 && !canSeeExceptions) {
      throw new FrontlineValidationError("A current scoped authority is required for restricted frontline history.");
    }
    const [evidence, exceptions] = await Promise.all([
      tx.select({
        id: onbFrontlineEvidence.id, kind: onbFrontlineEvidence.kind, statutoryKey: onbFrontlineEvidence.statutoryKey,
        skillRequirementKey: onbFrontlineEvidence.skillRequirementKey, status: onbFrontlineEvidence.status,
        expiresAt: onbFrontlineEvidence.expiresAt, createdAt: onbFrontlineEvidence.createdAt,
      }).from(onbFrontlineEvidence).where(and(eq(onbFrontlineEvidence.organizationId, input.organizationId), eq(onbFrontlineEvidence.caseId, input.caseId))),
      tx.select({
        id: onbFrontlinePolicyExceptions.id, item: onbFrontlinePolicyExceptions.item, type: onbFrontlinePolicyExceptions.type,
        revokedAt: onbFrontlinePolicyExceptions.revokedAt, expiresAt: onbFrontlinePolicyExceptions.expiresAt,
      }).from(onbFrontlinePolicyExceptions).where(and(eq(onbFrontlinePolicyExceptions.organizationId, input.organizationId), eq(onbFrontlinePolicyExceptions.caseId, input.caseId))),
    ]);
    return {
      evidence: evidence.filter((row) => allowedScopes.has(authorityScopeForEvidence(row.kind))).map((row) => ({
        id: row.id, kind: row.kind, ...(row.statutoryKey ? { statutoryKey: row.statutoryKey } : {}),
        ...(row.skillRequirementKey ? { skillRequirementKey: row.skillRequirementKey } : {}),
        status: row.status, expiryState: row.expiresAt && row.expiresAt <= new Date() ? "expired" : row.expiresAt ? "current-with-expiry" : "no-expiry-recorded",
      })),
      exceptions: canSeeExceptions ? exceptions.map((row) => ({ id: row.id, item: row.item, type: row.type, status: row.revokedAt ? "revoked" : row.expiresAt && row.expiresAt <= new Date() ? "expired" : "current" })) : [],
    };
  });
}

/** Live release boundary: no provider effect, no cached decision, and no release by a checklist label. */
export async function evaluateFrontlineFloorRelease(input: {
  organizationId: string; caseId: number; actorUserId: string; expectedVersion: number;
}) {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    if (!isFrontline(c)) throw new FrontlineValidationError("This case is not established as frontline/site work.");
    const state = await lockedState(tx, input.organizationId, input.caseId);
    assertVersion(state, input.expectedVersion);
    const release = await evaluateRelease(tx, c);
    const now = new Date();
    if (release.blockers.length) {
      if (state?.status === "released") {
        await reopenApprovalInTransaction(tx, {
          organizationId: input.organizationId, caseId: input.caseId, idempotencyKey: `gateway-c:${input.caseId}:human-queue`,
          reason: "Live frontline release evidence changed; a fresh human final review is required.", actor: input.actorUserId,
        });
        await tx.update(onbCases).set({
          lifecycleStage: "preboarding", orchestrationStatus: "checklist-blocked", orchestrationCheckpoint: "blocked:frontline-live-review",
          orchestrationClaimOwner: null, orchestrationClaimUntil: null, updatedAt: now,
        }).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)));
      }
      const version = await bumpState(tx, c, state, { status: "blocked", reblockedAt: state?.status === "released" ? now : state?.reblockedAt ?? null });
      return { caseId: input.caseId, version, release: { eligible: false, recorded: false, blockers: release.blockers, reblocked: state?.status === "released" }, fulfillments: release.fulfillment };
    }
    const releaseAuthority = await currentAuthority(tx, c, input.actorUserId, "hr-compliance-approve");
    if (state?.status === "released") {
      return { caseId: input.caseId, version: state.version, release: { eligible: true, recorded: true, blockers: [], reblocked: false }, fulfillments: release.fulfillment };
    }
    const version = await bumpState(tx, c, state, { status: "released", releasedAt: now, releasedByUserId: releaseAuthority.personUserId, reblockedAt: null });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId, caseId: input.caseId, agent: "frontline-floor-release", engine: "human",
      hitlPattern: "human-review", ruleRef: "Appendix A floor-release boundary",
      title: "Floor release passed current independent evidence checks",
      detail: "No remote provisioning was dispatched. The boundary was evaluated from current independent evidence, authority, expiry, acknowledgement, and shortage state.",
      idempotencyKey: `frontline-floor-release:${input.caseId}:v${version}`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
    return { caseId: input.caseId, version, release: { eligible: true, recorded: true, blockers: [], reblocked: false }, fulfillments: release.fulfillment };
  }));
}