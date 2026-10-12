import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  EARLY_TENURE_ASSIGNMENT_KINDS,
  onbAuthorityAssignments,
  onbCases,
  onbConnectors,
  onbEarlyTenureAssignments,
  onbEarlyTenureCaseSnapshots,
  onbEarlyTenureCheckins,
  onbEarlyTenureEvidence,
  onbEarlyTenurePolicyVersions,
  onbEarlyTenureReminders,
  onbEvents,
  onbProbationDecisions,
  organizationMembershipsTable,
  type OnbAuthorityScope,
  type OnbEarlyTenureAssignmentKind,
  type OnbEarlyTenureCheckInPolicy,
  type OnbEarlyTenureObligationPolicy,
  type OnbEarlyTenurePolicy,
} from "@workspace/db/schema";
import { sendAdministrativeEmail } from "./channels";
import { hasCurrentAuthorityScope, roleMayExerciseScope } from "./decision-authority";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { isRetiredControllerCase } from "./controller-retirement";
import { type OnboardingDbTransaction } from "./settings";
import {
  assertCaseDerivedLifecycleWriteAllowedInTransaction,
  SensitiveLifecycleConflictError,
  withSensitiveLifecycleFence,
} from "./sensitive-lifecycle";

export const EARLY_TENURE_WORKER = "early-tenure-worker";
const DECISION_SCOPES: readonly OnbAuthorityScope[] = [
  "hr-compliance-approve", "legal-approve", "occupational-health-approve",
  "payroll-approve", "fraud-control-approve", "manager-approve",
  "application-owner-approve", "security-approve", "it-security-approve",
];

function bad(message: string): never {
  const error = new Error(message);
  error.name = "EarlyTenureValidationError";
  throw error;
}
function conflict(message: string): never {
  const error = new Error(message);
  error.name = "EarlyTenureConflict";
  throw error;
}
function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) bad(`${field} is required and must be at most ${max} characters.`);
  return value.trim();
}
function date(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) bad(`${field} must be a valid ISO date/time.`);
  return new Date(value);
}
function dateOnlyAnchor(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error("Case joining date is invalid; early-tenure enrollment requires a valid planned joining date.");
  }
  return new Date(`${value}T00:00:00.000Z`);
}
function addDays(anchor: Date, offsetDays: number): Date {
  return new Date(anchor.getTime() + offsetDays * 86_400_000);
}
function unknownObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function stringArray(value: unknown, field: string, max = 50): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    bad(`${field} must be an array of up to ${max} non-empty strings.`);
  }
  return value.map((item) => (item as string).trim());
}
function optionalStringArray(value: unknown, field: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, field);
}
function isEarlyTenureApplicable(policy: OnbEarlyTenurePolicy, c: typeof onbCases.$inferSelect): boolean {
  const applies = policy.applicability;
  return (!applies.hireTypes?.length || applies.hireTypes.includes(c.hireType)) &&
    (!applies.workerCategories?.length || applies.workerCategories.includes(c.workerCategory)) &&
    (!applies.legalEntities?.length || applies.legalEntities.includes(c.legalEntity));
}

export function validateEarlyTenurePolicy(input: unknown): OnbEarlyTenurePolicy {
  const body = unknownObject(input, "policy");
  const allowed = new Set(["applicability", "probationLengthDays", "decisionAuthorityScope", "obligations", "checkIns"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) bad("policy contains unsupported fields.");
  const applicabilityRaw = body.applicability === undefined ? {} : unknownObject(body.applicability, "policy.applicability");
  if (Object.keys(applicabilityRaw).some((key) => !["hireTypes", "workerCategories", "legalEntities"].includes(key))) {
    bad("policy.applicability contains unsupported fields.");
  }
  const probationLengthDays = body.probationLengthDays;
  if (!Number.isInteger(probationLengthDays) || (probationLengthDays as number) < 1 || (probationLengthDays as number) > 730) {
    bad("policy.probationLengthDays must be an integer from 1 to 730; 30/60/90 check-ins do not define probation.");
  }
  if (typeof body.decisionAuthorityScope !== "string" || !DECISION_SCOPES.includes(body.decisionAuthorityScope as OnbAuthorityScope)) {
    bad("policy.decisionAuthorityScope must be an existing non-administrative authority scope.");
  }
  if (!Array.isArray(body.obligations) || !body.obligations.length || body.obligations.length > 30) bad("policy.obligations must contain 1–30 obligations.");
  const obligationKeys = new Set<string>();
  const obligations = body.obligations.map((value, index): OnbEarlyTenureObligationPolicy => {
    const row = unknownObject(value, `policy.obligations[${index}]`);
    if (Object.keys(row).some((key) => !["key", "kind", "label", "offsetDays", "required", "ownerRole", "requireEvidence", "connectorKey", "sourceConfirmationRequired", "structuredAgenda"].includes(key))) {
      bad(`policy.obligations[${index}] contains unsupported fields.`);
    }
    const key = text(row.key, `policy.obligations[${index}].key`, 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(key) || obligationKeys.has(key)) bad(`policy obligation key "${key}" is invalid or duplicated.`);
    obligationKeys.add(key);
    if (typeof row.kind !== "string" || !EARLY_TENURE_ASSIGNMENT_KINDS.includes(row.kind as OnbEarlyTenureAssignmentKind)) bad(`policy obligation "${key}" has an invalid kind.`);
    if (!Number.isInteger(row.offsetDays) || (row.offsetDays as number) < -30 || (row.offsetDays as number) > 730) bad(`policy obligation "${key}" has an invalid offsetDays.`);
    if (typeof row.required !== "boolean" || typeof row.requireEvidence !== "boolean") bad(`policy obligation "${key}" must declare required and requireEvidence.`);
    if (typeof row.sourceConfirmationRequired !== "undefined" && typeof row.sourceConfirmationRequired !== "boolean") bad(`policy obligation "${key}" has invalid sourceConfirmationRequired.`);
    const kind = row.kind as OnbEarlyTenureAssignmentKind;
    const connectorKey = row.connectorKey === undefined ? undefined : text(row.connectorKey, `policy obligation "${key}" connectorKey`, 100);
    if (row.sourceConfirmationRequired === true && !connectorKey) bad(`policy obligation "${key}" requires a connectorKey for source confirmation.`);
    const structuredAgenda = row.structuredAgenda === undefined ? undefined : stringArray(row.structuredAgenda, `policy obligation "${key}" structuredAgenda`, 20);
    if (kind === "manager-connect" && (!structuredAgenda || !structuredAgenda.length)) bad(`manager-connect obligation "${key}" requires a structuredAgenda.`);
    return {
      key, kind, label: text(row.label, `policy obligation "${key}" label`, 200),
      offsetDays: row.offsetDays as number, required: row.required, ownerRole: text(row.ownerRole, `policy obligation "${key}" ownerRole`, 100),
      requireEvidence: row.requireEvidence, connectorKey,
      sourceConfirmationRequired: row.sourceConfirmationRequired === true, structuredAgenda,
    };
  });
  for (const kind of ["induction", "learning-enrollment", "compliance-training", "buddy-acknowledgement", "manager-connect", "calendar-delivery"] as const) {
    const obligation = obligations.find((item) => item.kind === kind);
    if (!obligation || !obligation.required) {
      bad(`policy must include a required ${kind} obligation for every applicable early-tenure case.`);
    }
  }
  const calendarDelivery = obligations.find((item) => item.kind === "calendar-delivery")!;
  if (calendarDelivery.sourceConfirmationRequired || calendarDelivery.connectorKey) {
    bad("calendar-delivery must retain an explicit human-evidence fallback and cannot require a connector.");
  }
  if (!Array.isArray(body.checkIns) || !body.checkIns.length || body.checkIns.length > 12) bad("policy.checkIns must contain 1–12 check-ins.");
  const checkinKeys = new Set<string>();
  const checkinOffsets = new Set<number>();
  const checkIns = body.checkIns.map((value, index): OnbEarlyTenureCheckInPolicy => {
    const row = unknownObject(value, `policy.checkIns[${index}]`);
    if (Object.keys(row).some((key) => !["key", "label", "offsetDays", "required", "reminderLeadDays"].includes(key))) bad(`policy.checkIns[${index}] contains unsupported fields.`);
    const key = text(row.key, `policy.checkIns[${index}].key`, 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(key) || checkinKeys.has(key)) bad(`policy check-in key "${key}" is invalid or duplicated.`);
    checkinKeys.add(key);
    if (!Number.isInteger(row.offsetDays) || (row.offsetDays as number) < 0 || (row.offsetDays as number) > 730 || checkinOffsets.has(row.offsetDays as number)) bad(`policy check-in "${key}" has an invalid or duplicated offsetDays.`);
    checkinOffsets.add(row.offsetDays as number);
    if (typeof row.required !== "boolean" || !Number.isInteger(row.reminderLeadDays) || (row.reminderLeadDays as number) < 0 || (row.reminderLeadDays as number) > 60) bad(`policy check-in "${key}" is invalid.`);
    return { key, label: text(row.label, `policy check-in "${key}" label`, 200), offsetDays: row.offsetDays as number, required: row.required, reminderLeadDays: row.reminderLeadDays as number };
  });
  return {
    applicability: {
      hireTypes: optionalStringArray(applicabilityRaw.hireTypes, "policy.applicability.hireTypes"),
      workerCategories: optionalStringArray(applicabilityRaw.workerCategories, "policy.applicability.workerCategories"),
      legalEntities: optionalStringArray(applicabilityRaw.legalEntities, "policy.applicability.legalEntities"),
    },
    probationLengthDays: probationLengthDays as number,
    decisionAuthorityScope: body.decisionAuthorityScope as OnbAuthorityScope,
    obligations, checkIns,
  };
}

async function policyLock(tx: Pick<OnboardingDbTransaction, "execute">, organizationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`early-tenure:${organizationId}`}))`);
}
function ownerFor(c: typeof onbCases.$inferSelect, obligation: OnbEarlyTenureObligationPolicy): string {
  return obligation.ownerRole.toLowerCase() === "manager" ? c.managerName : obligation.ownerRole;
}
// Organization membership has no authoritative email attribute. Do not turn a
// browser-supplied string into an external recipient; unresolved stakeholders
// receive a durable in-app reminder instead.
function reminderEmail(_details: Record<string, unknown>): string | null { return null; }
function taskDetails(obligation: OnbEarlyTenureObligationPolicy): Record<string, unknown> {
  return {
    required: obligation.required,
    requireEvidence: obligation.requireEvidence,
    sourceConfirmationRequired: obligation.sourceConfirmationRequired === true,
    connectorRequirement: obligation.connectorKey ?? null,
    ...(obligation.kind === "buddy-acknowledgement"
      ? { acknowledgementRequired: true, buddyAssignment: "pending-human-assignment" }
      : {}),
    ...(obligation.kind === "manager-connect" ? { structuredAgenda: obligation.structuredAgenda } : {}),
  };
}
function caseAnchor(snapshot: typeof onbEarlyTenureCaseSnapshots.$inferSelect): Date {
  return snapshot.actualJoinedAt ?? dateOnlyAnchor(snapshot.plannedJoiningDate);
}

export async function getEarlyTenurePolicy(organizationId: string): Promise<{ version: number; policy: OnbEarlyTenurePolicy } | null> {
  const [row] = await db.select().from(onbEarlyTenurePolicyVersions)
    .where(eq(onbEarlyTenurePolicyVersions.organizationId, organizationId))
    .orderBy(desc(onbEarlyTenurePolicyVersions.version)).limit(1);
  return row ? { version: row.version, policy: validateEarlyTenurePolicy(row.policy) } : null;
}

export async function saveEarlyTenurePolicy(input: {
  organizationId: string; expectedVersion: number; policy: unknown; actorUserId: string; createdBy: string;
}): Promise<{ version: number; policy: OnbEarlyTenurePolicy }> {
  const policy = validateEarlyTenurePolicy(input.policy);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) bad("expectedVersion must be a non-negative integer.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await policyLock(tx, input.organizationId);
    if (!(await hasCurrentAuthorityScope(tx, {
      organizationId: input.organizationId, actorUserId: input.actorUserId, scope: "authority-administration",
    }))) throw new Error("Current governance-approved authority-administration assignment is required to publish early-tenure policy.");
    const [current] = await tx.select().from(onbEarlyTenurePolicyVersions)
      .where(eq(onbEarlyTenurePolicyVersions.organizationId, input.organizationId))
      .orderBy(desc(onbEarlyTenurePolicyVersions.version)).limit(1).for("update");
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) conflict(`Early-tenure policy changed since it was loaded (current version ${currentVersion}).`);
    const version = currentVersion + 1;
    await tx.insert(onbEarlyTenurePolicyVersions).values({
      organizationId: input.organizationId, version, policy, createdByUserId: input.actorUserId, createdBy: input.createdBy,
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId, caseId: null, agent: "early-tenure-policy", engine: "rules",
      hitlPattern: "governed-setting", ruleRef: "Early-tenure policy",
      title: "Early-tenure policy published",
      detail: `Policy version ${version} defines an explicit probation length and authority scope; existing case snapshots remain unchanged.`,
      idempotencyKey: `early-tenure-policy:${input.organizationId}:${version}`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
    return { version, policy };
  }));
}

async function requireCaseAuthority(tx: OnboardingDbTransaction, organizationId: string, caseId: number, actorUserId: string): Promise<typeof onbCases.$inferSelect> {
  const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId))).for("update");
  if (!c) throw new Error("Case not found.");
  if (isSyntheticOfflineCase(c) || isRetiredControllerCase(c)) throw new Error("Synthetic/offline or retired cases cannot be enrolled or completed as early-tenure evidence.");
  // Assignments, acknowledgements and evidence are opaque case-derived
  // content. Retention coverage/holds must allow their collection before any
  // durable early-tenure write occurs.
  await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
  if (!(await hasCurrentAuthorityScope(tx, { organizationId, actorUserId, scope: "hr-compliance-approve", caseId }))) {
    throw new Error("Current governance-approved HR compliance authority is required.");
  }
  return c;
}

/** Read access exposes dated evidence and employment-decision metadata, so it
 * requires the same live, case-scoped HR-compliance authority but never turns
 * a read into a lifecycle collection/write gate. */
async function requireCaseSensitiveReadAuthority(
  tx: OnboardingDbTransaction, organizationId: string, caseId: number, actorUserId: string,
): Promise<typeof onbCases.$inferSelect> {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
  )).for("update");
  if (!c) throw new Error("Case not found.");
  if (isSyntheticOfflineCase(c)) throw new Error("Synthetic/offline cases do not expose early-tenure evidence.");
  if (!(await hasCurrentAuthorityScope(tx, { organizationId, actorUserId, scope: "hr-compliance-approve", caseId }))) {
    throw new Error("Current governance-approved HR compliance authority is required.");
  }
  return c;
}

/** Bind the decision to the exact live grant revision rather than recording a
 * role label or treating a successful authorization check as durable evidence. */
async function currentAuthorityBinding(
  tx: OnboardingDbTransaction,
  c: typeof onbCases.$inferSelect,
  actorUserId: string,
  scope: OnbAuthorityScope,
): Promise<{ id: string; revision: number } | null> {
  if (!(await hasCurrentAuthorityScope(tx, {
    organizationId: c.organizationId, actorUserId, scope, caseId: c.id,
  }))) return null;
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, c.organizationId),
    eq(onbAuthorityAssignments.personUserId, actorUserId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    sql`(${onbAuthorityAssignments.validUntil} is null or ${onbAuthorityAssignments.validUntil} > ${now})`,
  )).for("update");
  const row = rows.find((item) =>
    item.scopes.includes(scope) &&
    roleMayExerciseScope(item.authorityRole, scope) &&
    (item.caseId === null || item.caseId === c.id) &&
    (!item.siteScope || item.siteScope === c.geography) &&
    (!item.jurisdictionScope || item.jurisdictionScope === c.legalEntity)
  );
  return row ? { id: row.id, revision: row.revision } : null;
}

export async function enrollEarlyTenureCase(input: {
  organizationId: string; caseId: number; actorUserId: string; enrolledBy: string;
}): Promise<{ enrolled: boolean; reason?: string }> {
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    await policyLock(tx, input.organizationId);
    const c = await requireCaseAuthority(tx, input.organizationId, input.caseId, input.actorUserId);
    if (c.lifecycleStage === "complete" || c.lifecycleStage === "cancelled") return { enrolled: false, reason: "Completed or cancelled cases are not replayed into early tenure." };
    const [existing] = await tx.select().from(onbEarlyTenureCaseSnapshots).where(and(
      eq(onbEarlyTenureCaseSnapshots.organizationId, input.organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, input.caseId),
    )).for("update");
    if (existing) return { enrolled: true };
    const [policyRow] = await tx.select().from(onbEarlyTenurePolicyVersions)
      .where(eq(onbEarlyTenurePolicyVersions.organizationId, input.organizationId))
      .orderBy(desc(onbEarlyTenurePolicyVersions.version)).limit(1).for("update");
    if (!policyRow) throw new Error("A governed early-tenure policy must be published before enrollment.");
    const policy = validateEarlyTenurePolicy(policyRow.policy);
    if (!isEarlyTenureApplicable(policy, c)) return { enrolled: false, reason: "This case does not match the governed early-tenure policy applicability." };
    const anchor = dateOnlyAnchor(c.joiningDate);
    await tx.insert(onbEarlyTenureCaseSnapshots).values({
      organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: 1, policyVersion: policyRow.version,
      policy, plannedJoiningDate: c.joiningDate, enrolledByUserId: input.actorUserId, enrolledBy: input.enrolledBy,
    });
    if (policy.obligations.length) await tx.insert(onbEarlyTenureAssignments).values(policy.obligations.map((item) => ({
      organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: 1, obligationKey: item.key, revision: 1,
      kind: item.kind, title: item.label, ownerName: ownerFor(c, item), dueAt: addDays(anchor, item.offsetDays), anchorRevision: 0,
      sourceConfirmationRequired: item.sourceConfirmationRequired === true, requiredConnectorKey: item.connectorKey ?? null,
      taskDetails: taskDetails(item),
    })));
    if (policy.checkIns.length) await tx.insert(onbEarlyTenureCheckins).values(policy.checkIns.map((item) => ({
      organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: 1, checkinKey: item.key,
      revision: 1, anchorRevision: 0, label: item.label, dueAt: addDays(anchor, item.offsetDays), reminderLeadDays: item.reminderLeadDays, required: item.required,
    })));
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId, caseId: input.caseId, agent: "early-tenure", engine: "rules",
      hitlPattern: "human-task", ruleRef: "Early tenure enrollment",
      title: "Early-tenure obligations assigned",
      detail: `${policy.obligations.length} explicit human/source-confirmed obligations and ${policy.checkIns.length} actual-join-anchored check-ins were enrolled. No task was marked complete.`,
      idempotencyKey: `early-tenure:${input.caseId}:enrollment:1`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
    return { enrolled: true };
  }));
}

async function suppressPendingTargetReminders(
  tx: OnboardingDbTransaction, organizationId: string, caseId: number, targetType: "assignment" | "checkin", targetId: number, reason: string, now: Date,
): Promise<void> {
  await tx.update(onbEarlyTenureReminders).set({
    status: "suppressed", deliveryInfo: `Suppressed: ${reason}`, lastError: reason.slice(0, 500), claimOwner: null, claimUntil: null, updatedAt: now,
  }).where(and(
    eq(onbEarlyTenureReminders.organizationId, organizationId), eq(onbEarlyTenureReminders.caseId, caseId),
    eq(onbEarlyTenureReminders.targetType, targetType), eq(onbEarlyTenureReminders.targetId, targetId),
    inArray(onbEarlyTenureReminders.status, ["pending", "claimed"]),
  ));
}

/** 0073 introduced an explicit auto-anchor fence. For a pre-0073 revision-2
 * current row, accept only a provable predecessor link from revision 1 whose
 * old due date exactly matches the prior planned anchor. Anything else is
 * intentionally ambiguous and requires a human revision rather than an
 * invented schedule provenance. */
async function reconciledLegacyAutoAnchorRevision(
  tx: OnboardingDbTransaction,
  input: {
    target: "assignment" | "checkin"; organizationId: string; rowId: number;
    revision: number; priorDueAt: Date; plannedDueAt: Date; currentAnchorRevision: number;
  },
): Promise<number | null> {
  if (input.revision !== 2) return null;
  const table = input.target === "assignment" ? onbEarlyTenureAssignments : onbEarlyTenureCheckins;
  const [previous] = await tx.select().from(table).where(and(
    eq(table.organizationId, input.organizationId),
    eq(table.revision, 1),
    eq(input.target === "assignment" ? onbEarlyTenureAssignments.supersededByAssignmentId : onbEarlyTenureCheckins.supersededByCheckinId, input.rowId),
  )).for("update");
  return previous && previous.dueAt.getTime() === input.plannedDueAt.getTime() &&
    input.priorDueAt.getTime() !== input.plannedDueAt.getTime()
    ? input.currentAnchorRevision
    : null;
}

export async function setActualJoiningAnchor(input: {
  organizationId: string; caseId: number; actualJoinedAt: string; expectedAnchorRevision: number; actorUserId: string; recordedBy: string;
}): Promise<void> {
  const actual = date(input.actualJoinedAt, "actualJoinedAt");
  if (actual.getTime() > Date.now() + 5 * 60_000) bad("actualJoinedAt cannot be in the future.");
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const c = await requireCaseAuthority(tx, input.organizationId, input.caseId, input.actorUserId);
    const [snapshot] = await tx.select().from(onbEarlyTenureCaseSnapshots).where(and(
      eq(onbEarlyTenureCaseSnapshots.organizationId, input.organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, input.caseId),
    )).for("update");
    if (!snapshot) throw new Error("Case is not enrolled in early tenure.");
    if (snapshot.anchorRevision !== input.expectedAnchorRevision) conflict("Actual joining anchor changed since it was loaded.");
    const now = new Date();
    const nextRevision = snapshot.anchorRevision + 1;
    await tx.update(onbEarlyTenureCaseSnapshots).set({ actualJoinedAt: actual, anchorRevision: nextRevision, updatedAt: now }).where(and(
      eq(onbEarlyTenureCaseSnapshots.organizationId, input.organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, input.caseId),
      eq(onbEarlyTenureCaseSnapshots.anchorRevision, input.expectedAnchorRevision),
    ));
    const plannedAnchor = dateOnlyAnchor(snapshot.plannedJoiningDate);
    const assignments = await tx.select().from(onbEarlyTenureAssignments).where(and(
      eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.caseId, input.caseId),
      eq(onbEarlyTenureAssignments.status, "pending"),
    )).for("update");
    for (const row of assignments) {
      const obligation = snapshot.policy.obligations.find((item) => item.key === row.obligationKey);
      // A late actual-start correction must re-anchor even an overdue task when
      // it is still the untouched planned-anchor revision. Never rewrite a
      // manually revised, completed, cancelled, or historical task.
      if (!obligation) continue;
      const previousAnchor = snapshot.actualJoinedAt ?? plannedAnchor;
      const autoDueAt = addDays(previousAnchor, obligation.offsetDays);
      const trackedAnchorRevision = row.anchorRevision ??
        (row.revision === 1 && row.dueAt.getTime() === autoDueAt.getTime()
          ? snapshot.anchorRevision
          : await reconciledLegacyAutoAnchorRevision(tx, {
            target: "assignment", organizationId: input.organizationId, rowId: row.id, revision: row.revision,
            priorDueAt: row.dueAt, plannedDueAt: addDays(plannedAnchor, obligation.offsetDays),
            currentAnchorRevision: snapshot.anchorRevision,
          }));
      if (trackedAnchorRevision !== snapshot.anchorRevision || row.dueAt.getTime() !== addDays(previousAnchor, obligation.offsetDays).getTime()) continue;
      const [next] = await tx.insert(onbEarlyTenureAssignments).values({
        organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: row.snapshotVersion,
        obligationKey: row.obligationKey, revision: row.revision + 1, kind: row.kind, title: row.title,
        ownerName: row.ownerName, ownerUserId: row.ownerUserId, dueAt: addDays(actual, obligation.offsetDays), anchorRevision: nextRevision,
        sourceConfirmationRequired: row.sourceConfirmationRequired, requiredConnectorKey: row.requiredConnectorKey, taskDetails: row.taskDetails,
      }).returning({ id: onbEarlyTenureAssignments.id });
      await tx.update(onbEarlyTenureAssignments).set({ status: "superseded", supersededAt: now, supersededByAssignmentId: next!.id, updatedAt: now })
        .where(and(eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, row.id), eq(onbEarlyTenureAssignments.status, "pending")));
      await suppressPendingTargetReminders(tx, input.organizationId, input.caseId, "assignment", row.id, "actual joining anchor revised", now);
    }
    const checkins = await tx.select().from(onbEarlyTenureCheckins).where(and(
      eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.caseId, input.caseId),
      eq(onbEarlyTenureCheckins.status, "scheduled"),
    )).for("update");
    for (const row of checkins) {
      const checkin = snapshot.policy.checkIns.find((item) => item.key === row.checkinKey);
      if (!checkin) continue;
      const previousAnchor = snapshot.actualJoinedAt ?? plannedAnchor;
      const autoDueAt = addDays(previousAnchor, checkin.offsetDays);
      const trackedAnchorRevision = row.anchorRevision ??
        (row.revision === 1 && row.dueAt.getTime() === autoDueAt.getTime()
          ? snapshot.anchorRevision
          : await reconciledLegacyAutoAnchorRevision(tx, {
            target: "checkin", organizationId: input.organizationId, rowId: row.id, revision: row.revision,
            priorDueAt: row.dueAt, plannedDueAt: addDays(plannedAnchor, checkin.offsetDays),
            currentAnchorRevision: snapshot.anchorRevision,
          }));
      if (trackedAnchorRevision !== snapshot.anchorRevision || row.dueAt.getTime() !== addDays(previousAnchor, checkin.offsetDays).getTime()) continue;
      const [next] = await tx.insert(onbEarlyTenureCheckins).values({
        organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: row.snapshotVersion, checkinKey: row.checkinKey,
        revision: row.revision + 1, anchorRevision: nextRevision, label: row.label, ownerUserId: row.ownerUserId, dueAt: addDays(actual, checkin.offsetDays), reminderLeadDays: row.reminderLeadDays, required: row.required,
      }).returning({ id: onbEarlyTenureCheckins.id });
      await tx.update(onbEarlyTenureCheckins).set({ status: "superseded", supersededAt: now, supersededByCheckinId: next!.id, updatedAt: now })
        .where(and(eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.id, row.id), eq(onbEarlyTenureCheckins.status, "scheduled")));
      await suppressPendingTargetReminders(tx, input.organizationId, input.caseId, "checkin", row.id, "actual joining anchor revised", now);
    }
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId, caseId: input.caseId, agent: "early-tenure", engine: "rules", hitlPattern: "human-record",
      ruleRef: "Actual joining anchor", title: "Actual joining anchor recorded",
      detail: `An authorized human recorded actual joining at ${actual.toISOString()}; only incomplete future work was revised.`,
      idempotencyKey: `early-tenure:${input.caseId}:anchor:${nextRevision}`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
    void c;
  }));
}

export async function reviseEarlyTenureAssignment(input: {
  organizationId: string; assignmentId: number; expectedRevision: number; actorUserId: string; ownerName: string; ownerUserId?: string | null;
  dueAt: string; taskDetails?: unknown; notificationRecipientEmail?: string | null;
}): Promise<void> {
  const dueAt = date(input.dueAt, "dueAt");
  if (dueAt <= new Date()) bad("Revised assignment dueAt must be in the future.");
  const ownerName = text(input.ownerName, "ownerName", 200);
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbEarlyTenureAssignments).where(and(eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, input.assignmentId))).for("update");
    if (!row) throw new Error("Assignment not found.");
    await requireCaseAuthority(tx, input.organizationId, row.caseId, input.actorUserId);
    const now = new Date();
    if (row.status !== "pending" || row.revision !== input.expectedRevision || row.dueAt <= now) conflict("Only the current incomplete future assignment can be revised.");
    if (!input.ownerUserId) bad("ownerUserId must be a current tenant member for an assignment revision.");
    const [ownerMembership] = await tx.select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, input.organizationId),
        eq(organizationMembershipsTable.clerkUserId, input.ownerUserId),
        isNull(organizationMembershipsTable.revokedAt),
      )).limit(1);
    if (!ownerMembership) throw new Error("ownerUserId must identify a current tenant member.");
    if (input.notificationRecipientEmail) {
      bad("External reminder email cannot be bound to a tenant member because this service has no authoritative membership-email mapping; use the durable in-app reminder.");
    }
    const details = input.taskDetails === undefined ? { ...row.taskDetails } : unknownObject(input.taskDetails, "taskDetails");
    if (input.notificationRecipientEmail !== undefined) details.notificationRecipientEmail = input.notificationRecipientEmail ?? null;
    if (row.kind === "buddy-acknowledgement") {
      const buddyUserId = details.buddyUserId;
      if (buddyUserId !== undefined && typeof buddyUserId !== "string") bad("buddyUserId must be a tenant member id when supplied.");
      if (details.buddyAssignment === "assigned" && !buddyUserId) bad("An assigned buddy acknowledgement requires buddyUserId.");
      if (typeof buddyUserId === "string") {
        const [buddyMembership] = await tx.select({ id: organizationMembershipsTable.id })
          .from(organizationMembershipsTable).where(and(
            eq(organizationMembershipsTable.organizationId, input.organizationId),
            eq(organizationMembershipsTable.clerkUserId, buddyUserId),
            isNull(organizationMembershipsTable.revokedAt),
          )).limit(1);
        if (!buddyMembership) throw new Error("buddyUserId must identify a current tenant member.");
        details.buddyAssignment = "assigned";
      }
    }
    const [next] = await tx.insert(onbEarlyTenureAssignments).values({
      organizationId: row.organizationId, caseId: row.caseId, snapshotVersion: row.snapshotVersion, obligationKey: row.obligationKey, revision: row.revision + 1,
      kind: row.kind, title: row.title, ownerName, ownerUserId: input.ownerUserId ?? null, dueAt, anchorRevision: null, sourceConfirmationRequired: row.sourceConfirmationRequired,
      requiredConnectorKey: row.requiredConnectorKey, taskDetails: details,
    }).returning({ id: onbEarlyTenureAssignments.id });
    await tx.update(onbEarlyTenureAssignments).set({ status: "superseded", supersededAt: now, supersededByAssignmentId: next!.id, updatedAt: now })
      .where(and(eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, row.id), eq(onbEarlyTenureAssignments.revision, input.expectedRevision), eq(onbEarlyTenureAssignments.status, "pending")));
    await suppressPendingTargetReminders(tx, input.organizationId, row.caseId, "assignment", row.id, "assignment revised", now);
  }));
}

/** Late/Day-0 work cannot be abandoned because the schedule is no longer
 * editable. This narrow operation assigns only the current owner; it leaves
 * the due date intact and revision-fences the handoff. */
export async function assignEarlyTenureAssignmentOwner(input: {
  organizationId: string; assignmentId: number; expectedRevision: number; ownerUserId: string; actorUserId: string; buddyUserId?: string;
}): Promise<void> {
  if (!input.ownerUserId.trim()) bad("ownerUserId is required.");
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbEarlyTenureAssignments).where(and(
      eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, input.assignmentId),
    )).for("update");
    if (!row) throw new Error("Assignment not found.");
    await requireCaseAuthority(tx, input.organizationId, row.caseId, input.actorUserId);
    if (row.status !== "pending" || row.revision !== input.expectedRevision) conflict("Assignment changed since it was loaded.");
    const details = { ...row.taskDetails };
    const buddyUserId = row.kind === "buddy-acknowledgement"
      ? input.buddyUserId ?? (typeof details.buddyUserId === "string" ? details.buddyUserId : undefined)
      : undefined;
    if (row.kind === "buddy-acknowledgement" && !buddyUserId) {
      bad("A buddy acknowledgement owner assignment requires buddyUserId.");
    }
    const memberIds = [input.ownerUserId, ...(buddyUserId ? [buddyUserId] : [])];
    const members = await tx.select({ userId: organizationMembershipsTable.clerkUserId }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, input.organizationId),
      inArray(organizationMembershipsTable.clerkUserId, memberIds),
      isNull(organizationMembershipsTable.revokedAt),
    ));
    if (new Set(members.map((member) => member.userId)).size !== new Set(memberIds).size) {
      throw new Error("ownerUserId and buddyUserId must identify current tenant members.");
    }
    if (row.kind === "buddy-acknowledgement") {
      details.buddyUserId = buddyUserId;
      details.buddyAssignment = "assigned";
    }
    const now = new Date();
    const [next] = await tx.insert(onbEarlyTenureAssignments).values({
      organizationId: row.organizationId, caseId: row.caseId, snapshotVersion: row.snapshotVersion,
      obligationKey: row.obligationKey, revision: row.revision + 1, kind: row.kind, title: row.title,
      ownerName: row.ownerName, ownerUserId: input.ownerUserId, dueAt: row.dueAt, anchorRevision: row.anchorRevision,
      sourceConfirmationRequired: row.sourceConfirmationRequired, requiredConnectorKey: row.requiredConnectorKey, taskDetails: details,
    }).returning({ id: onbEarlyTenureAssignments.id });
    await tx.update(onbEarlyTenureAssignments).set({
      status: "superseded", supersededAt: now, supersededByAssignmentId: next!.id, updatedAt: now,
    }).where(and(eq(onbEarlyTenureAssignments.id, row.id), eq(onbEarlyTenureAssignments.status, "pending"), eq(onbEarlyTenureAssignments.revision, input.expectedRevision)));
    await suppressPendingTargetReminders(tx, input.organizationId, row.caseId, "assignment", row.id, "assignment owner assigned", now);
  }));
}

type EarlyTenureEvidenceInput = {
  organizationId: string; assignmentId: number; actorUserId: string; recordedBy: string; evidenceReference: string; provenance: "human-authorized" | "trusted-provider";
  sourceConnectorKey?: string; observedAt: string; note?: string; ownerScoped?: boolean;
};

async function recordEarlyTenureEvidenceInternal(input: EarlyTenureEvidenceInput): Promise<void> {
  const observedAt = date(input.observedAt, "observedAt");
  if (observedAt.getTime() > Date.now() + 5 * 60_000) bad("observedAt cannot be in the future.");
  const evidenceReference = text(input.evidenceReference, "evidenceReference", 2_000);
  if (input.provenance !== "human-authorized" && input.provenance !== "trusted-provider") bad("Evidence provenance must be human-authorized or trusted-provider.");
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [assignment] = await tx.select().from(onbEarlyTenureAssignments).where(and(eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, input.assignmentId))).for("update");
    if (!assignment) throw new Error("Assignment not found.");
    if (input.ownerScoped) {
      const [membership] = await tx.select({ id: organizationMembershipsTable.id })
        .from(organizationMembershipsTable).where(and(
          eq(organizationMembershipsTable.organizationId, input.organizationId),
          eq(organizationMembershipsTable.clerkUserId, input.actorUserId),
          isNull(organizationMembershipsTable.revokedAt),
        )).limit(1).for("update");
      if (!membership || assignment.ownerUserId !== input.actorUserId) {
        throw new Error("A current assigned tenant member is required to record this task evidence.");
      }
      await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, {
        organizationId: input.organizationId, caseId: assignment.caseId,
      });
    } else {
      await requireCaseAuthority(tx, input.organizationId, assignment.caseId, input.actorUserId);
    }
    if (assignment.status !== "pending") conflict("Evidence can only complete the current pending assignment.");
    if (assignment.kind === "compliance-training") {
      const [enrollment] = await tx.select({ id: onbEarlyTenureAssignments.id }).from(onbEarlyTenureAssignments).where(and(
        eq(onbEarlyTenureAssignments.organizationId, input.organizationId),
        eq(onbEarlyTenureAssignments.caseId, assignment.caseId),
        eq(onbEarlyTenureAssignments.kind, "learning-enrollment"),
        eq(onbEarlyTenureAssignments.status, "completed"),
      )).limit(1);
      if (!enrollment) {
        bad("Compliance completion requires dated evidence that the separate learning-enrollment obligation is completed.");
      }
    }
    if (assignment.sourceConfirmationRequired) {
      if (input.provenance !== "trusted-provider" || input.sourceConnectorKey !== assignment.requiredConnectorKey) {
        bad("This assignment requires trusted confirmation from its configured connector; human assertion cannot simulate completion.");
      }
      const [connector] = await tx.select().from(onbConnectors).where(and(
        eq(onbConnectors.organizationId, input.organizationId), eq(onbConnectors.key, input.sourceConnectorKey),
      ));
      if (!connector || connector.status !== "connected" || connector.configurationProvenance !== "trusted-provider") {
        throw new Error("Configured learning/calendar connector is not a trusted active source.");
      }
    } else if (input.provenance !== "human-authorized") {
      bad("This explicit human task requires human-authorized evidence.");
    }
    const now = new Date();
    await tx.insert(onbEarlyTenureEvidence).values({
      organizationId: input.organizationId, caseId: assignment.caseId, assignmentId: assignment.id, evidenceReference,
      provenance: input.provenance, sourceConnectorKey: input.sourceConnectorKey ?? null, recordedByUserId: input.actorUserId,
      recordedBy: input.recordedBy, observedAt, note: input.note ? text(input.note, "note", 2_000) : null,
    });
    await tx.update(onbEarlyTenureAssignments).set({ status: "completed", completedAt: observedAt, completedByUserId: input.actorUserId, updatedAt: now })
      .where(and(eq(onbEarlyTenureAssignments.organizationId, input.organizationId), eq(onbEarlyTenureAssignments.id, assignment.id), eq(onbEarlyTenureAssignments.status, "pending")));
    await suppressPendingTargetReminders(tx, input.organizationId, assignment.caseId, "assignment", assignment.id, "assignment completed with dated evidence", now);
  }));
}

/** Browser and ordinary human workflows may only record reviewed human
 * evidence. They cannot manufacture a connector provenance/source key. */
export async function recordEarlyTenureEvidence(input: Omit<EarlyTenureEvidenceInput, "provenance" | "sourceConnectorKey"> & {
  provenance?: "human-authorized";
  sourceConnectorKey?: never;
}): Promise<void> {
  return recordEarlyTenureEvidenceInternal({ ...input, provenance: "human-authorized" });
}

/** Assigned member path for an inbox task. It can record only human evidence
 * for its own active assignment and returns no broader case information. */
export async function recordMyEarlyTenureEvidence(input: Omit<EarlyTenureEvidenceInput, "provenance" | "sourceConnectorKey" | "ownerScoped"> & {
  provenance?: "human-authorized"; sourceConnectorKey?: never;
}): Promise<void> {
  return recordEarlyTenureEvidenceInternal({ ...input, provenance: "human-authorized", ownerScoped: true });
}

/** Reserved for authenticated, server-owned connector adapters after their
 * provider signature/activation boundary; no HTTP/browser route calls this. */
export async function recordTrustedEarlyTenureEvidenceFromAdapter(
  input: Omit<EarlyTenureEvidenceInput, "provenance">,
): Promise<void> {
  return recordEarlyTenureEvidenceInternal({ ...input, provenance: "trusted-provider" });
}

export async function completeEarlyTenureCheckin(input: {
  organizationId: string; checkinId: number; expectedRevision: number; actorUserId: string; evidenceReference: string; completedAt: string;
}): Promise<void> {
  const completedAt = date(input.completedAt, "completedAt");
  if (completedAt.getTime() > Date.now() + 5 * 60_000) bad("completedAt cannot be in the future.");
  const evidenceReference = text(input.evidenceReference, "evidenceReference", 2_000);
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbEarlyTenureCheckins).where(and(eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.id, input.checkinId))).for("update");
    if (!row) throw new Error("Check-in not found.");
    await requireCaseAuthority(tx, input.organizationId, row.caseId, input.actorUserId);
    if (row.status !== "scheduled" || row.revision !== input.expectedRevision) conflict("Check-in changed since it was loaded.");
    const now = new Date();
    await tx.update(onbEarlyTenureCheckins).set({ status: "completed", completedAt, completedByUserId: input.actorUserId, evidenceReference, updatedAt: now })
      .where(and(eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.id, row.id), eq(onbEarlyTenureCheckins.status, "scheduled"), eq(onbEarlyTenureCheckins.revision, input.expectedRevision)));
    await suppressPendingTargetReminders(tx, input.organizationId, row.caseId, "checkin", row.id, "check-in completed with dated evidence", now);
  }));
}

/** Assigning the accountable member is a revisioned human operation. Generic
 * HR labels are not a dispatch recipient and cannot populate the inbox. */
export async function assignEarlyTenureCheckinOwner(input: {
  organizationId: string; checkinId: number; expectedRevision: number; ownerUserId: string; actorUserId: string;
}): Promise<void> {
  if (!input.ownerUserId.trim()) bad("ownerUserId is required.");
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbEarlyTenureCheckins).where(and(
      eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.id, input.checkinId),
    )).for("update");
    if (!row) throw new Error("Check-in not found.");
    await requireCaseAuthority(tx, input.organizationId, row.caseId, input.actorUserId);
    if (row.status !== "scheduled" || row.revision !== input.expectedRevision) conflict("Check-in changed since it was loaded.");
    const [member] = await tx.select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, input.organizationId),
        eq(organizationMembershipsTable.clerkUserId, input.ownerUserId),
        isNull(organizationMembershipsTable.revokedAt),
      )).limit(1);
    if (!member) throw new Error("ownerUserId must identify a current tenant member.");
    const now = new Date();
    const [next] = await tx.insert(onbEarlyTenureCheckins).values({
      organizationId: row.organizationId, caseId: row.caseId, snapshotVersion: row.snapshotVersion,
      checkinKey: row.checkinKey, revision: row.revision + 1, anchorRevision: row.anchorRevision,
      label: row.label, ownerUserId: input.ownerUserId, dueAt: row.dueAt,
      reminderLeadDays: row.reminderLeadDays, required: row.required,
    }).returning({ id: onbEarlyTenureCheckins.id });
    await tx.update(onbEarlyTenureCheckins).set({
      status: "superseded", supersededAt: now, supersededByCheckinId: next!.id, updatedAt: now,
    }).where(and(
      eq(onbEarlyTenureCheckins.organizationId, input.organizationId), eq(onbEarlyTenureCheckins.id, row.id),
      eq(onbEarlyTenureCheckins.status, "scheduled"), eq(onbEarlyTenureCheckins.revision, input.expectedRevision),
    ));
    await suppressPendingTargetReminders(tx, input.organizationId, row.caseId, "checkin", row.id, "check-in owner assigned", now);
  }));
}

export async function recordProbationDecision(input: {
  organizationId: string; caseId: number; expectedSnapshotVersion: number; expectedAnchorRevision: number; expectedDecisionVersion: number; actorUserId: string; decidedBy: string;
  disposition: "confirmed" | "extended" | "reviewed-other"; effectiveAt: string; extensionEndsAt?: string; rationale: string; evidenceReference: string;
}): Promise<void> {
  const effectiveAt = date(input.effectiveAt, "effectiveAt");
  const extensionEndsAt = input.extensionEndsAt ? date(input.extensionEndsAt, "extensionEndsAt") : null;
  if (effectiveAt.getTime() > Date.now() + 5 * 60_000) bad("Probation decision effectiveAt cannot be in the future.");
  if (!["confirmed", "extended", "reviewed-other"].includes(input.disposition)) bad("Probation disposition must be confirmed, extended, or reviewed-other; adverse decisions are never automated here.");
    if (input.disposition === "extended" && (!extensionEndsAt || extensionEndsAt <= effectiveAt)) bad("An extension requires extensionEndsAt after effectiveAt.");
  if (input.disposition !== "extended" && extensionEndsAt) bad("Only an extension may include extensionEndsAt.");
  await withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async (tx) => {
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId))).for("update");
    if (!c || isSyntheticOfflineCase(c) || isRetiredControllerCase(c)) throw new Error("Case not found or not eligible for probation decision.");
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, {
      organizationId: input.organizationId, caseId: input.caseId,
    });
    const [snapshot] = await tx.select().from(onbEarlyTenureCaseSnapshots).where(and(eq(onbEarlyTenureCaseSnapshots.organizationId, input.organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, input.caseId))).for("update");
    if (!snapshot || snapshot.snapshotVersion !== input.expectedSnapshotVersion) conflict("Early-tenure policy snapshot changed or is not enrolled.");
    if (!snapshot.actualJoinedAt) throw new Error("An actual joining anchor is required before a probation decision can be recorded.");
    if (snapshot.anchorRevision !== input.expectedAnchorRevision) conflict("Actual joining anchor changed since it was loaded; review probation evidence before retrying.");
    if (effectiveAt < snapshot.actualJoinedAt) bad("Probation decision effectiveAt cannot precede actual joining.");
    if (!c.createdByUserId || c.createdByUserId === input.actorUserId) throw new Error("Probation decision requires verified separation from the case creator.");
    const authority = await currentAuthorityBinding(tx, c, input.actorUserId, snapshot.policy.decisionAuthorityScope);
    if (!authority) throw new Error("A current governance-approved authority matching the snapshot probation decision scope is required.");
    const [latest] = await tx.select().from(onbProbationDecisions).where(and(eq(onbProbationDecisions.organizationId, input.organizationId), eq(onbProbationDecisions.caseId, input.caseId)))
      .orderBy(desc(onbProbationDecisions.decisionVersion)).limit(1).for("update");
    const actualVersion = latest?.decisionVersion ?? 0;
    if (actualVersion !== input.expectedDecisionVersion) conflict("Probation decision changed since it was loaded.");
    const sameAnchorDecisions = await tx.select({ extensionEndsAt: onbProbationDecisions.extensionEndsAt })
      .from(onbProbationDecisions).where(and(
        eq(onbProbationDecisions.organizationId, input.organizationId),
        eq(onbProbationDecisions.caseId, input.caseId),
        eq(onbProbationDecisions.anchorRevision, snapshot.anchorRevision),
      )).for("update");
    const maturityAt = addDays(snapshot.actualJoinedAt, snapshot.policy.probationLengthDays);
    const governedEndAt = sameAnchorDecisions.reduce(
      (end, decision) => decision.extensionEndsAt && decision.extensionEndsAt > end ? decision.extensionEndsAt : end,
      maturityAt,
    );
    if (input.disposition === "confirmed" && effectiveAt < governedEndAt) {
      bad("A confirmed probation decision cannot take effect before the current governed probation end.");
    }
    if (input.disposition === "extended" && extensionEndsAt! <= governedEndAt) {
      bad("An extension must end after the current governed probation end.");
    }
    await tx.insert(onbProbationDecisions).values({
      organizationId: input.organizationId, caseId: input.caseId, snapshotVersion: snapshot.snapshotVersion, decisionVersion: actualVersion + 1,
      disposition: input.disposition, effectiveAt, extensionEndsAt, rationale: text(input.rationale, "rationale", 4_000),
      evidenceReference: text(input.evidenceReference, "evidenceReference", 2_000), decidedByUserId: input.actorUserId, decidedBy: input.decidedBy,
      anchorRevision: snapshot.anchorRevision, authorityId: authority.id, authorityRevision: authority.revision, decidedAt: new Date(),
    });
    await tx.insert(onbEvents).values({
      organizationId: input.organizationId, caseId: input.caseId, agent: "early-tenure", engine: "rules", hitlPattern: "authorized-human-decision",
      ruleRef: "Probation disposition", title: "Authorized probation disposition recorded",
      detail: `An authorized human recorded "${input.disposition}". This is a reviewed record, not an automated employment decision.`,
      idempotencyKey: `early-tenure:${input.caseId}:probation:${actualVersion + 1}`,
    }).onConflictDoNothing({ target: [onbEvents.organizationId, onbEvents.idempotencyKey] });
  }));
}

export async function getEarlyTenureView(organizationId: string, caseId: number, actorUserId: string): Promise<Record<string, unknown> | null> {
  return db.transaction(async (tx) => {
    const c = await requireCaseSensitiveReadAuthority(tx, organizationId, caseId, actorUserId);
    const [snapshot] = await tx.select().from(onbEarlyTenureCaseSnapshots).where(and(eq(onbEarlyTenureCaseSnapshots.organizationId, organizationId), eq(onbEarlyTenureCaseSnapshots.caseId, caseId)));
    if (!snapshot) return { caseId, enrolled: false };
    const [assignments, checkins, evidence, reminders, decisions] = await Promise.all([
      tx.select().from(onbEarlyTenureAssignments).where(and(eq(onbEarlyTenureAssignments.organizationId, organizationId), eq(onbEarlyTenureAssignments.caseId, caseId), inArray(onbEarlyTenureAssignments.status, ["pending", "completed"]))).orderBy(asc(onbEarlyTenureAssignments.dueAt)),
      tx.select().from(onbEarlyTenureCheckins).where(and(eq(onbEarlyTenureCheckins.organizationId, organizationId), eq(onbEarlyTenureCheckins.caseId, caseId), inArray(onbEarlyTenureCheckins.status, ["scheduled", "completed"]))).orderBy(asc(onbEarlyTenureCheckins.dueAt)),
      tx.select().from(onbEarlyTenureEvidence).where(and(eq(onbEarlyTenureEvidence.organizationId, organizationId), eq(onbEarlyTenureEvidence.caseId, caseId))).orderBy(desc(onbEarlyTenureEvidence.createdAt)),
      tx.select().from(onbEarlyTenureReminders).where(and(eq(onbEarlyTenureReminders.organizationId, organizationId), eq(onbEarlyTenureReminders.caseId, caseId))).orderBy(desc(onbEarlyTenureReminders.createdAt)),
      tx.select().from(onbProbationDecisions).where(and(eq(onbProbationDecisions.organizationId, organizationId), eq(onbProbationDecisions.caseId, caseId))).orderBy(desc(onbProbationDecisions.decisionVersion)),
    ]);
    const currentAssignmentIds = new Set(assignments.map((assignment) => assignment.id));
    const currentCheckinIds = new Set(checkins.map((checkin) => checkin.id));
    void c;
    return {
      caseId, enrolled: true, snapshot, assignments, checkins,
      evidence: evidence.filter((item) => currentAssignmentIds.has(item.assignmentId)),
      reminders: reminders.filter((item) => item.targetType === "assignment"
        ? currentAssignmentIds.has(item.targetId)
        : currentCheckinIds.has(item.targetId)),
      probation: {
        lengthDays: snapshot.policy.probationLengthDays, decisionAuthorityScope: snapshot.policy.decisionAuthorityScope,
        maturityAt: snapshot.actualJoinedAt ? addDays(snapshot.actualJoinedAt, snapshot.policy.probationLengthDays) : null,
        governedEndAt: snapshot.actualJoinedAt
          ? decisions.filter((decision) => decision.anchorRevision === snapshot.anchorRevision).reduce(
            (end, decision) => decision.extensionEndsAt && decision.extensionEndsAt > end ? decision.extensionEndsAt : end,
            addDays(snapshot.actualJoinedAt, snapshot.policy.probationLengthDays),
          )
          : null,
        decisions: decisions.map((decision) => ({
          ...decision, staleAgainstCurrentAnchor: decision.anchorRevision !== snapshot.anchorRevision,
        })),
      },
    };
  });
}

/** Minimal, member-scoped in-app inbox. It deliberately excludes worker/case
 * narrative and only acknowledges a reminder after this member-visible
 * projection is returned. */
export async function getEarlyTenureReminderInbox(organizationId: string, actorUserId: string) {
  return withSensitiveLifecycleFence(organizationId, () => db.transaction(async (tx) => {
    const [membership] = await tx.select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, actorUserId),
        isNull(organizationMembershipsTable.revokedAt),
      )).for("update");
    if (!membership) throw new Error("A current tenant membership is required for the early-tenure inbox.");
    const assignmentRows = await tx.select({
      id: onbEarlyTenureReminders.id,
      targetType: onbEarlyTenureReminders.targetType,
      targetId: onbEarlyTenureReminders.targetId,
      dueAt: onbEarlyTenureReminders.dueAt,
      availableAt: onbEarlyTenureReminders.availableAt,
      obligationLabel: onbEarlyTenureAssignments.title,
      assignmentId: onbEarlyTenureAssignments.id,
    }).from(onbEarlyTenureReminders).innerJoin(onbEarlyTenureAssignments, and(
      eq(onbEarlyTenureAssignments.organizationId, onbEarlyTenureReminders.organizationId),
      eq(onbEarlyTenureAssignments.id, onbEarlyTenureReminders.targetId),
      eq(onbEarlyTenureAssignments.revision, onbEarlyTenureReminders.targetRevision),
    )).where(and(
      eq(onbEarlyTenureReminders.organizationId, organizationId),
      eq(onbEarlyTenureReminders.targetType, "assignment"),
      inArray(onbEarlyTenureReminders.status, ["pending", "sent"]),
      eq(onbEarlyTenureAssignments.status, "pending"),
      eq(onbEarlyTenureAssignments.ownerUserId, actorUserId),
      lte(onbEarlyTenureReminders.availableAt, new Date()),
    )).for("update");
    const checkinRows = await tx.select({
      id: onbEarlyTenureReminders.id,
      targetType: onbEarlyTenureReminders.targetType,
      targetId: onbEarlyTenureReminders.targetId,
      dueAt: onbEarlyTenureReminders.dueAt,
      availableAt: onbEarlyTenureReminders.availableAt,
      obligationLabel: onbEarlyTenureCheckins.label,
    }).from(onbEarlyTenureReminders).innerJoin(onbEarlyTenureCheckins, and(
      eq(onbEarlyTenureCheckins.organizationId, onbEarlyTenureReminders.organizationId),
      eq(onbEarlyTenureCheckins.id, onbEarlyTenureReminders.targetId),
      eq(onbEarlyTenureCheckins.revision, onbEarlyTenureReminders.targetRevision),
    )).where(and(
      eq(onbEarlyTenureReminders.organizationId, organizationId),
      eq(onbEarlyTenureReminders.targetType, "checkin"),
      inArray(onbEarlyTenureReminders.status, ["pending", "sent"]),
      eq(onbEarlyTenureCheckins.status, "scheduled"),
      eq(onbEarlyTenureCheckins.ownerUserId, actorUserId),
      lte(onbEarlyTenureReminders.availableAt, new Date()),
    )).for("update");
    const rows = [...assignmentRows.map(({ assignmentId: _assignmentId, ...row }) => row), ...checkinRows];
    if (rows.length) {
      await tx.update(onbEarlyTenureReminders).set({
        status: "sent", claimOwner: null, claimUntil: null,
        deliveryInfo: "Visible in the assigned member's in-app early-tenure inbox.", updatedAt: new Date(),
      }).where(and(
        eq(onbEarlyTenureReminders.organizationId, organizationId),
        inArray(onbEarlyTenureReminders.id, rows.map((row) => row.id)),
        eq(onbEarlyTenureReminders.status, "pending"),
      ));
    }
    return rows.map((row) => ({
      ...row,
      // Opaque stable reference lets the member take the action without
      // exposing worker, department, manager, or case narrative in an inbox.
      taskReference: `early-tenure:${row.targetType}:${row.targetId}`,
      evidenceCompletionPath: row.targetType === "assignment"
        ? `/onboarding/early-tenure/assignments/${row.targetId}/my-evidence`
        : null,
    }));
  }));
}

export async function listEarlyTenureOwnerOptions(organizationId: string, caseId: number, actorUserId: string) {
  return db.transaction(async (tx) => {
    await requireCaseSensitiveReadAuthority(tx, organizationId, caseId, actorUserId);
    return tx.select({
      userId: organizationMembershipsTable.clerkUserId,
      role: organizationMembershipsTable.role,
    }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      isNull(organizationMembershipsTable.revokedAt),
    )).orderBy(asc(organizationMembershipsTable.clerkUserId));
  });
}

async function enqueueDueReminders(now: Date): Promise<number> {
  const assignments = await db.select().from(onbEarlyTenureAssignments).where(and(
    eq(onbEarlyTenureAssignments.status, "pending"), isNotNull(onbEarlyTenureAssignments.ownerUserId),
    lte(onbEarlyTenureAssignments.dueAt, now),
    // Filter already-outboxed current revisions before the bounded scan. A
    // naïve first-500 selection repeatedly re-reads the same pending targets
    // and can starve later tenants forever.
    sql`exists (
      select 1 from organization_memberships membership
      where membership.organization_id = ${onbEarlyTenureAssignments.organizationId}
        and membership.clerk_user_id = ${onbEarlyTenureAssignments.ownerUserId}
        and membership.revoked_at is null
    )`,
    sql`not exists (
      select 1 from onb_early_tenure_reminders reminder
      where reminder.organization_id = ${onbEarlyTenureAssignments.organizationId}
        and reminder.event_key = ('early-tenure:assignment:' || ${onbEarlyTenureAssignments.id} || ':revision:' || ${onbEarlyTenureAssignments.revision} || ':due')
    )`,
  )).limit(500);
  const checkins = await db.select().from(onbEarlyTenureCheckins).where(and(
    eq(onbEarlyTenureCheckins.status, "scheduled"), isNotNull(onbEarlyTenureCheckins.ownerUserId),
    sql`${onbEarlyTenureCheckins.dueAt} - (${onbEarlyTenureCheckins.reminderLeadDays} * interval '1 day') <= ${now}`,
    sql`exists (
      select 1 from organization_memberships membership
      where membership.organization_id = ${onbEarlyTenureCheckins.organizationId}
        and membership.clerk_user_id = ${onbEarlyTenureCheckins.ownerUserId}
        and membership.revoked_at is null
    )`,
    sql`not exists (
      select 1 from onb_early_tenure_reminders reminder
      where reminder.organization_id = ${onbEarlyTenureCheckins.organizationId}
        and reminder.event_key = ('early-tenure:checkin:' || ${onbEarlyTenureCheckins.id} || ':revision:' || ${onbEarlyTenureCheckins.revision} || ':due')
    )`,
  )).limit(500);
  let queued = 0;
  for (const row of assignments) {
    const key = `early-tenure:assignment:${row.id}:revision:${row.revision}:due`;
    try {
      const created = await withSensitiveLifecycleFence(row.organizationId, () => db.transaction(async (tx) => {
        await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId: row.organizationId, caseId: row.caseId });
        const [current] = await tx.select().from(onbEarlyTenureAssignments).where(and(
          eq(onbEarlyTenureAssignments.organizationId, row.organizationId), eq(onbEarlyTenureAssignments.id, row.id),
          eq(onbEarlyTenureAssignments.status, "pending"), eq(onbEarlyTenureAssignments.revision, row.revision),
        )).for("update");
        if (!current) return false;
        const [ownerMembership] = await tx.select({ id: organizationMembershipsTable.id })
          .from(organizationMembershipsTable).where(and(
            eq(organizationMembershipsTable.organizationId, current.organizationId),
            eq(organizationMembershipsTable.clerkUserId, current.ownerUserId!),
            isNull(organizationMembershipsTable.revokedAt),
          )).for("update");
        if (!ownerMembership) return false;
        const inserted = await tx.insert(onbEarlyTenureReminders).values({
          organizationId: row.organizationId, caseId: row.caseId, targetType: "assignment", targetId: row.id, targetRevision: row.revision, eventKey: key,
          intendedRecipient: current.ownerName, recipientEmail: reminderEmail(current.taskDetails), dueAt: current.dueAt, availableAt: now,
        }).onConflictDoNothing({ target: [onbEarlyTenureReminders.organizationId, onbEarlyTenureReminders.eventKey] }).returning({ id: onbEarlyTenureReminders.id });
        return inserted.length > 0;
      }));
      if (created) queued += 1;
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
    }
  }
  for (const row of checkins) {
    const key = `early-tenure:checkin:${row.id}:revision:${row.revision}:due`;
    try {
      const created = await withSensitiveLifecycleFence(row.organizationId, () => db.transaction(async (tx) => {
        await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId: row.organizationId, caseId: row.caseId });
        const [current] = await tx.select().from(onbEarlyTenureCheckins).where(and(
          eq(onbEarlyTenureCheckins.organizationId, row.organizationId), eq(onbEarlyTenureCheckins.id, row.id),
          eq(onbEarlyTenureCheckins.status, "scheduled"), eq(onbEarlyTenureCheckins.revision, row.revision),
        )).for("update");
        if (!current) return false;
        const [ownerMembership] = await tx.select({ id: organizationMembershipsTable.id })
          .from(organizationMembershipsTable).where(and(
            eq(organizationMembershipsTable.organizationId, current.organizationId),
            eq(organizationMembershipsTable.clerkUserId, current.ownerUserId!),
            isNull(organizationMembershipsTable.revokedAt),
          )).for("update");
        if (!ownerMembership) return false;
        const inserted = await tx.insert(onbEarlyTenureReminders).values({
          organizationId: row.organizationId, caseId: row.caseId, targetType: "checkin", targetId: row.id, targetRevision: row.revision, eventKey: key,
          intendedRecipient: "Assigned HR compliance owner", recipientEmail: null, dueAt: current.dueAt,
          availableAt: new Date(current.dueAt.getTime() - current.reminderLeadDays * 86_400_000),
        }).onConflictDoNothing({ target: [onbEarlyTenureReminders.organizationId, onbEarlyTenureReminders.eventKey] }).returning({ id: onbEarlyTenureReminders.id });
        return inserted.length > 0;
      }));
      if (created) queued += 1;
    } catch (error) {
      if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
    }
  }
  return queued;
}

async function claimReminder(id: number, owner: string, now: Date) {
  const [initial] = await db.select({ organizationId: onbEarlyTenureReminders.organizationId }).from(onbEarlyTenureReminders).where(eq(onbEarlyTenureReminders.id, id));
  if (!initial) return null;
  return withSensitiveLifecycleFence(initial.organizationId, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbEarlyTenureReminders).where(and(eq(onbEarlyTenureReminders.organizationId, initial.organizationId), eq(onbEarlyTenureReminders.id, id))).for("update");
    if (!row || row.status !== "pending" || row.availableAt > now) return null;
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, row.organizationId), eq(onbCases.id, row.caseId))).for("update");
    if (!c || isSyntheticOfflineCase(c) || isRetiredControllerCase(c)) {
      await tx.update(onbEarlyTenureReminders).set({ status: "suppressed", deliveryInfo: "Suppressed: case unavailable or synthetic.", updatedAt: now }).where(eq(onbEarlyTenureReminders.id, id));
      return null;
    }
    const target = row.targetType === "assignment"
      ? await tx.select().from(onbEarlyTenureAssignments).where(and(eq(onbEarlyTenureAssignments.organizationId, row.organizationId), eq(onbEarlyTenureAssignments.id, row.targetId))).for("update")
      : await tx.select().from(onbEarlyTenureCheckins).where(and(eq(onbEarlyTenureCheckins.organizationId, row.organizationId), eq(onbEarlyTenureCheckins.id, row.targetId))).for("update");
    const current = target[0];
    const active = row.targetType === "assignment" ? current?.status === "pending" : current?.status === "scheduled";
    if (!current || !active || current.revision !== row.targetRevision) {
      await tx.update(onbEarlyTenureReminders).set({ status: "suppressed", deliveryInfo: "Suppressed: target was completed, superseded, or is no longer due.", updatedAt: now }).where(eq(onbEarlyTenureReminders.id, id));
      return null;
    }
    const [claimed] = await tx.update(onbEarlyTenureReminders).set({
      status: "claimed", claimOwner: owner, claimUntil: new Date(now.getTime() + 60_000), attempts: sql`${onbEarlyTenureReminders.attempts} + 1`, updatedAt: now,
    }).where(and(eq(onbEarlyTenureReminders.id, id), eq(onbEarlyTenureReminders.status, "pending"))).returning();
    return claimed ?? null;
  }));
}

export async function runEarlyTenureReminderTick(options: { now?: Date; owner?: string } = {}): Promise<{ queued: number; sent: number; failures: number }> {
  const now = options.now ?? new Date();
  const owner = options.owner ?? `early-tenure:${randomUUID()}`;
  const queued = await enqueueDueReminders(now);
  await db.update(onbEarlyTenureReminders).set({ status: "unknown", claimOwner: null, claimUntil: null, deliveryInfo: "Claim expired; delivery outcome requires manual reconciliation.", updatedAt: now })
    .where(and(eq(onbEarlyTenureReminders.status, "claimed"), lte(onbEarlyTenureReminders.claimUntil, now)));
  const pending = await db.select().from(onbEarlyTenureReminders).where(and(
    eq(onbEarlyTenureReminders.status, "pending"), isNotNull(onbEarlyTenureReminders.recipientEmail),
    lte(onbEarlyTenureReminders.availableAt, now),
  )).orderBy(asc(onbEarlyTenureReminders.id)).limit(100);
  let sent = 0; let failures = 0;
  for (const item of pending) {
    const row = await claimReminder(item.id, owner, now);
    if (!row) continue;
    const outcome = await withSensitiveLifecycleFence(row.organizationId, async () => {
      // Keep the tenant fence from the final target/recipient check through
      // provider dispatch. An anchor or assignment revision either suppresses
      // this claim first, or waits until this already-valid dispatch finishes.
      const prepared = await db.transaction(async (tx) => {
        const [claimed] = await tx.select().from(onbEarlyTenureReminders).where(and(
          eq(onbEarlyTenureReminders.organizationId, row.organizationId),
          eq(onbEarlyTenureReminders.id, row.id),
        )).for("update");
        if (!claimed || claimed.status !== "claimed" || claimed.claimOwner !== owner || !claimed.claimUntil || claimed.claimUntil <= now) return null;
        try {
          await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, {
            organizationId: claimed.organizationId, caseId: claimed.caseId,
          });
        } catch (error) {
          if (!(error instanceof SensitiveLifecycleConflictError)) throw error;
          await tx.update(onbEarlyTenureReminders).set({
            status: "suppressed", claimOwner: null, claimUntil: null,
            deliveryInfo: "Suppressed: sensitive lifecycle collection/retention gate no longer permits reminder dispatch.", updatedAt: now,
          }).where(eq(onbEarlyTenureReminders.id, claimed.id));
          return null;
        }
        const target = claimed.targetType === "assignment"
          ? await tx.select().from(onbEarlyTenureAssignments).where(and(eq(onbEarlyTenureAssignments.organizationId, claimed.organizationId), eq(onbEarlyTenureAssignments.id, claimed.targetId))).for("update")
          : await tx.select().from(onbEarlyTenureCheckins).where(and(eq(onbEarlyTenureCheckins.organizationId, claimed.organizationId), eq(onbEarlyTenureCheckins.id, claimed.targetId))).for("update");
        const current = target[0];
        const active = claimed.targetType === "assignment" ? current?.status === "pending" : current?.status === "scheduled";
        if (!current || !active || current.revision !== claimed.targetRevision) {
          await tx.update(onbEarlyTenureReminders).set({
            status: "suppressed", claimOwner: null, claimUntil: null,
            deliveryInfo: "Suppressed: target changed after reminder claim.", updatedAt: now,
          }).where(eq(onbEarlyTenureReminders.id, claimed.id));
          return null;
        }
        // Old rows created before the authoritative member-email rule are
        // never sent. This service stores no verified membership-email
        // mapping, so a raw address cannot establish a current recipient.
        if (claimed.recipientEmail) {
          await tx.update(onbEarlyTenureReminders).set({
            status: "suppressed", claimOwner: null, claimUntil: null,
            deliveryInfo: "Suppressed: external recipient is not backed by an authoritative tenant-member email mapping.", updatedAt: now,
          }).where(eq(onbEarlyTenureReminders.id, claimed.id));
          return null;
        }
        return claimed;
      });
      if (!prepared) return "suppressed" as const;
      if (!prepared.recipientEmail) {
        await db.update(onbEarlyTenureReminders).set({
          status: "sent", claimUntil: null,
          deliveryInfo: `Durable in-app reminder queued for intended stakeholder "${prepared.intendedRecipient}"; no bound administrative email recipient is configured.`,
          updatedAt: now,
        }).where(and(eq(onbEarlyTenureReminders.id, prepared.id), eq(onbEarlyTenureReminders.status, "claimed"), eq(onbEarlyTenureReminders.claimOwner, owner)));
        return "sent" as const;
      }
      try {
        const result = await sendAdministrativeEmail({
          caseId: prepared.caseId, toAddress: prepared.recipientEmail,
          subject: "[Onboarding] Early-tenure task due",
          body: `Early-tenure work is due. Intended stakeholder: ${prepared.intendedRecipient}. Sign in to the same organization to review and record dated human/source evidence. This reminder does not complete work or make an employment decision.`,
          idempotencyKey: `early-tenure-reminder:${prepared.organizationId}:${prepared.eventKey}`,
        });
        const terminal = result.status === "sending" ? "unknown" : result.status === "sent" ? "sent" : "failed";
        await db.update(onbEarlyTenureReminders).set({
          status: terminal, claimUntil: null, deliveryInfo: result.status === "sent" ? `Administrative email accepted for intended stakeholder "${prepared.intendedRecipient}".` : result.failureReason,
          lastError: terminal === "sent" ? null : result.failureReason, updatedAt: now,
        }).where(and(eq(onbEarlyTenureReminders.id, prepared.id), eq(onbEarlyTenureReminders.status, "claimed"), eq(onbEarlyTenureReminders.claimOwner, owner)));
        return terminal === "sent" ? "sent" as const : "failed" as const;
      } catch (error) {
        await db.update(onbEarlyTenureReminders).set({ status: "unknown", claimUntil: null, deliveryInfo: "Delivery outcome is unknown; manual reconciliation required.", lastError: String(error).slice(0, 500), updatedAt: now })
          .where(and(eq(onbEarlyTenureReminders.id, prepared.id), eq(onbEarlyTenureReminders.status, "claimed"), eq(onbEarlyTenureReminders.claimOwner, owner)));
        return "failed" as const;
      }
    });
    if (outcome === "sent") sent += 1;
    else if (outcome === "failed") failures += 1;
  }
  return { queued, sent, failures };
}