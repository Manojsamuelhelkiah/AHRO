import { and, eq, like } from "drizzle-orm";
import { onbCases, onbSettings } from "@workspace/db";
import type { OfflineCasePreparation } from "@workspace/db/schema";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { isRetiredControllerCase } from "./controller-retirement";
import { activationRecord, operationalEligibilityInTransaction } from "./operational-eligibility";
import { canonicalIntakeHash, findHroTemplate, validateHroRows } from "./hro-batch-templates";
import { candidateEmailDeliveryDecision } from "./channel-routing";
import { hasHumanPermissions, isSharedDemoPrincipalInTransaction } from "../human-permissions";
import { resolveEffectiveAccessInTransaction } from "../access-governance";
import { evaluateCaseDerivedLifecycleGateInTransaction } from "./sensitive-lifecycle";
import type { OnboardingDbTransaction } from "./settings";

type CaseRow = typeof onbCases.$inferSelect;
export const PREPARATION_READ_KEYS = [
  "flow.case.read", "data.case.profile.read", "data.case.notes.read",
  "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read",
] as const;
export const PREPARATION_EDIT_KEYS = [
  ...PREPARATION_READ_KEYS, "flow.case.edit", "data.case.profile.edit", "data.case.notes.edit",
  "data.identity.edit", "data.medical.edit", "data.payroll.edit", "data.bgv.edit",
] as const;

/**
 * This is narrower than the historical display classifier: an exact
 * developer-owned inventory slot and its original fictional identity are
 * required. Mutable notes, generic UAT prefixes, or a real address never prove
 * eligibility. Run-ledger ownership is checked separately in the transaction.
 */
export function preparationSource(row: CaseRow) {
  if (isRetiredControllerCase({ ...row, controllerRetired: false })) return null;
  const source = CURATED_OFFLINE_EXAMPLES.find(example => example.key === row.scenarioKey);
  if (source && activationRecord(row, false)) return source;
  if (!source || row.organizationId !== "demo" ||
    row.syntheticProvenance !== source.values.syntheticProvenance ||
    row.workerName !== source.values.workerName || row.workerEmail !== source.values.workerEmail ||
    row.workerPhone !== null || row.candidateEmailAuthorizedAt !== null ||
    row.candidateEmailAuthorizedBy !== null ||
    row.checklistProfileId === "demo-controller" ||
    row.orchestrationCheckpoint?.startsWith("demo-controller") ||
    /\[demo-controller-run:/i.test(row.notes ?? "")) return null;
  return source;
}

/** Even a reserved example key cannot override actual run-ledger ownership. */
export async function actualRunOwnsCase(tx: Pick<OnboardingDbTransaction, "select">, row: CaseRow) {
  const settings = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, row.organizationId),
    like(onbSettings.key, "onboarding-uat.run.v1:%"),
  ));
  for (const setting of settings) {
    try {
      const run = JSON.parse(setting.value);
      // Uncertain ownership is never permission to operate.
      if (!run || typeof run !== "object" || Array.isArray(run) ||
        typeof run.runId !== "string" || !Array.isArray(run.linkedCaseIds) ||
        !run.linkedCaseIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)) return true;
      if (run.linkedCaseIds.includes(row.id)) return true;
    } catch { return true; }
  }
  return false;
}

export function validStoredPreparation(row: CaseRow): OfflineCasePreparation | null {
  const source = preparationSource(row);
  const draft = row.operationalPreparation;
  if (!source || !draft || draft.schema !== "offline-case-preparation/v1" ||
    draft.organizationId !== row.organizationId || draft.caseId !== row.id ||
    draft.sourceKey !== source.key || draft.sourceFingerprint !== canonicalIntakeHash(source.values) ||
    !Number.isSafeInteger(draft.revision) || draft.revision < 1 ||
    draft.templateId !== source.values.processPolicySnapshot.batchIntake.templateId ||
    draft.templateVersion !== findHroTemplate(draft.templateId)?.version ||
    !draft.data || typeof draft.data !== "object" || Array.isArray(draft.data) ||
    !Object.values(draft.data).every(value => typeof value === "string") ||
    typeof draft.updatedByUserId !== "string" || !draft.updatedByUserId ||
    !Number.isFinite(Date.parse(draft.updatedAt))) return null;
  return draft;
}

export function preparationInputIssues(templateId: string, input: Record<string, string>) {
  const template = findHroTemplate(templateId);
  if (!template) return [{ column: "template", message: "The current family template is unavailable." }];
  if (Object.hasOwn(input, "template_id") || Object.hasOwn(input, "template_version")) {
    return [{ column: "template", message: "Template identity and version are server-owned." }];
  }
  return validateHroRows(template.id, template.version, [{
    ...input, template_id: template.id, template_version: String(template.version),
  }]).issues;
}

export async function preparationView(tx: OnboardingDbTransaction, row: CaseRow, actorUserId: string) {
  const source = preparationSource(row);
  const access = await resolveEffectiveAccessInTransaction(tx, {
    organizationId: row.organizationId, caseId: row.id,
    principalType: "human", principalId: actorUserId, purpose: "operational-preparation",
  });
  if (!["flow.case.read", "data.case.profile.read"].every(key => access.allows.includes(key))) {
    throw new PreparationError(403, "Current case and profile read permissions are required.");
  }
  const owned = await actualRunOwnsCase(tx, row);
  const eligible = Boolean(source) && !owned;
  const draft = eligible ? validStoredPreparation(row) : null;
  const template = source ? findHroTemplate(source.values.processPolicySnapshot.batchIntake.templateId) : undefined;
  const sharedDemo = await isSharedDemoPrincipalInTransaction(tx, actorUserId);
  const canReadDraft = !sharedDemo && PREPARATION_READ_KEYS.every(key => access.allows.includes(key));
  const canEdit = eligible && await hasHumanPermissions(tx, {
    organizationId: row.organizationId, caseId: row.id, actorUserId,
    requiredKeys: PREPARATION_EDIT_KEYS,
  });
  const blockers: string[] = [];
  const active = activationRecord(row, false);
  let requirementsFingerprint: string | null = null;
  let workflowBlocker: string | null = null;
  let canActivate = false;
  let canReconfirm = false;
  let activationBlocked = false;
  if (!eligible) blockers.push(owned
    ? "Actual UAT run ownership is isolated and cannot be prepared for live operations."
    : "The exact fictional inventory provenance could not be verified. Real volunteer, controller and uncertain records remain restricted.");
  if (sharedDemo) blockers.push("Use a named account with live client and case permissions to save real information or perform transactions. Shared Demo accounts can view this preparation journey only.");
  else if (!canEdit) blockers.push("Current case-flow, profile, notes and sensitive-field permissions are required to save mixed operational request information.");
  if (eligible && template) {
    if (!canReadDraft && draft) blockers.push("Saved operational information is restricted by current field permissions.");
    else {
      blockers.push(...preparationInputIssues(template.id, draft?.data ?? {})
        .map(issue => `${issue.column}: ${issue.message}`));
      if (draft?.data.worker_email && !candidateEmailDeliveryDecision({ workerEmail: draft.data.worker_email }).allowed)
        blockers.push("Replace the fictional or undeliverable worker address with a real deliverable contact before activation.");
    }
    const collection = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
      organizationId: row.organizationId,
      jurisdiction: canReadDraft ? draft?.data.work_country || null : null,
    });
    if (!collection.allowed) blockers.push(collection.reason);
    if (canReadDraft) {
      const { activationPrerequisites, OFFLINE_OPERATIONAL_BOUNDARY_READY } = await import("./offline-activation");
      const requirements = await activationPrerequisites(tx, row, Boolean(active));
      requirementsFingerprint = requirements.fingerprint;
      workflowBlocker = requirements.workflowBlocker;
      for (const message of requirements.blockers) if (!blockers.includes(message)) blockers.push(message);
      canActivate = OFFLINE_OPERATIONAL_BOUNDARY_READY && canEdit && !active && requirements.blockers.length === 0;
      canReconfirm = OFFLINE_OPERATIONAL_BOUNDARY_READY && canEdit && Boolean(active) && requirements.blockers.length === 0;
      if (!OFFLINE_OPERATIONAL_BOUNDARY_READY)
        blockers.push("Operational activation safety validation is not yet complete. Preparation remains editable; it enables no live work.");
    }
    if (active) {
      const operational = await operationalEligibilityInTransaction(tx, row);
      activationBlocked = !operational.allowed;
      if (operational.reason) blockers.push(operational.reason);
      blockers.push(...row.readiness.filter(item => item.status !== "ready").map(item =>
        `${item.label}: current operational evidence or a permitted decision is still required.`));
    }
    if (workflowBlocker) blockers.push(workflowBlocker);
    if (!sharedDemo && !access.allows.includes("tool.external.dispatch"))
      blockers.push("Live transactions require the acting named user's current tool.external.dispatch permission; activation does not grant it.");
    blockers.push("Only configured, supported providers may execute. Simulated connectors are not live integrations; the normal workflow checks each operation before dispatch.");
  }
  return {
    caseId: row.id, eligible, canEdit, canReadData: canReadDraft, revision: draft?.revision ?? 0,
    canActivate, canReconfirm, requirementsFingerprint, workflowBlocker,
    workflowStarted: Boolean(active?.workflowStartedAt &&
      active.workflowStartedByUserId === active.activatedByUserId),
    canStart: Boolean(canReconfirm && !activationBlocked && !workflowBlocker &&
      !active?.workflowStartedAt && active?.activatedByUserId === actorUserId &&
      access.allows.includes("tool.workflow.run") && access.allows.includes("tool.external.dispatch")),
    sourceName: source?.values.workerName ?? null,
    sourceEmail: source?.values.workerEmail ?? null,
    activationGeneration: active?.generation ?? null,
    family: template?.family ?? null,
    state: !eligible ? "restricted-history" as const : active
      ? activationBlocked || workflowBlocker ? "activated-blocked" as const : "activated" as const
      : draft ? "preparing" as const : "unprepared" as const,
    sourceLabel: source ? `${source.family}: ${source.title} — fictional source retained` : "Restricted historical record",
    evidenceStatus: "unverified" as const,
    fields: eligible && template ? template.columns.filter(field =>
      !["template_id", "template_version"].includes(field.key)) : [],
    data: canReadDraft ? draft?.data ?? {} : {},
    blockers,
  };
}

export class PreparationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
