import { and, eq, getTableColumns, getTableName, like, sql, type AnyColumn, type SQLWrapper } from "drizzle-orm";
import { onbCases, onbSettings, type OfflineCaseActivation } from "@workspace/db";
import { recordedHumanPermissionDecisionCurrent } from "../human-permissions";
import type { OnboardingDbTransaction } from "./settings";
import { isHistoricalTestRecord as sourceHistorical } from "./historical-test-record";
import { isSyntheticOfflineCase as sourceOffline, isUatRunIsolatedCase as sourceUat } from "./synthetic-offline";
import { isRetiredControllerCase as sourceController } from "./controller-retirement";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { canonicalIntakeHash } from "./hro-batch-templates";
import { candidateEmailDeliveryDecision } from "./channel-routing";

type RecordLike = {
  id?: number; organizationId?: string; scenarioKey?: string | null;
  workerName?: string; workerEmail?: string; workerPhone?: string | null;
  syntheticProvenance?: string | null; controllerRetired?: boolean;
  notes?: string | null; candidateEmailAuthorizedBy?: string | null;
  checklistProfileId?: string | null; orchestrationCheckpoint?: string | null;
  operationalActivation?: OfflineCaseActivation | null;
};
const HISTORICAL_CHILDREN = {
  onb_approvals: "approvals", onb_communications: "communications",
  onb_documents: "documents", onb_system_checks: "systemChecks", onb_events: "events",
  onb_candidate_links: "candidateLinks", onb_candidate_sessions: "candidateSessions",
  onb_candidate_uploads: "candidateUploads",
  onb_early_tenure_survey_responses: "surveyResponses",
  onb_employment_outcome_evidence: "employmentEvidence",
} as const;
export const HISTORICAL_CHILD_KINDS = Object.values(HISTORICAL_CHILDREN);

function snapshotContainsChild(records: unknown, kind: string, id: number | string): boolean {
  if (!records || typeof records !== "object") return true;
  const items = (records as Record<string, unknown>)[kind];
  return !Array.isArray(items) || items.some(item =>
    item && typeof item === "object" && String((item as { id?: unknown; idHash?: unknown }).id ??
      (item as { idHash?: unknown }).idHash) === String(id));
}

export function operationalIdentityFingerprint(row: Pick<typeof onbCases.$inferSelect,
  "workerName" | "workerEmail" | "workerPhone" | "organizationId" | "id">) {
  return canonicalIntakeHash({
    organizationId: row.organizationId, caseId: row.id,
    workerName: row.workerName, workerEmail: row.workerEmail, workerPhone: row.workerPhone,
  });
}

/** A synchronous classification is never the final provider authorization. */
export function activationRecord(row: RecordLike, verifyCurrentIdentity = true): OfflineCaseActivation | null {
  const a = row.operationalActivation;
  if (!a || a.schema !== "offline-case-activation/v1" ||
    a.organizationId !== row.organizationId || a.organizationId !== "demo" ||
    a.caseId !== row.id || a.sourceKey !== row.scenarioKey ||
    typeof a.generation !== "string" || !/^[a-f0-9-]{36}$/.test(a.generation) ||
    !Number.isSafeInteger(a.preparationRevision) || a.preparationRevision < 1 ||
    !Number.isSafeInteger(a.permissionDecisionId) || a.permissionDecisionId >= 0 ||
    !a.activatedByUserId || !Number.isFinite(Date.parse(a.activatedAt)) ||
    (a.generationStartedAt !== undefined && !Number.isFinite(Date.parse(a.generationStartedAt))) ||
    !a.sourceSnapshot || typeof a.sourceSnapshot !== "object" || Array.isArray(a.sourceSnapshot) ||
    (a.previousGenerations !== undefined && !Array.isArray(a.previousGenerations))) return null;
  const source = CURATED_OFFLINE_EXAMPLES.find(s => s.key === a.sourceKey);
  const start = [a.workflowStartedAt, a.workflowStartedByUserId, a.workflowStartDecisionId];
  if (start.some(value => value !== undefined) && (
    !a.workflowStartedAt || !Number.isFinite(Date.parse(a.workflowStartedAt)) ||
    Date.parse(a.workflowStartedAt) < Date.parse(a.generationStartedAt ?? a.activatedAt) ||
    a.workflowStartedByUserId !== a.activatedByUserId ||
    !Number.isSafeInteger(a.workflowStartDecisionId) || a.workflowStartDecisionId! >= 0)) return null;
  const original = a.sourceSnapshot;
  if (!source || a.sourceFingerprint !== canonicalIntakeHash(source.values) ||
    !HISTORICAL_CHILD_KINDS.every(kind =>
      Array.isArray((original.retainedRecords as Record<string, unknown> | undefined)?.[kind])) ||
    (a.previousGenerations ?? []).some(item => !item || typeof item !== "object" ||
      !HISTORICAL_CHILD_KINDS.every(kind => Array.isArray(
        (item.retainedRecords as Record<string, unknown> | undefined)?.[kind]))) ||
    original.id !== row.id || original.organizationId !== row.organizationId ||
    original.scenarioKey !== source.key ||
    original.workerName !== source.values.workerName || original.workerEmail !== source.values.workerEmail ||
    original.syntheticProvenance !== source.values.syntheticProvenance ||
    row.syntheticProvenance !== source.values.syntheticProvenance ||
    original.workerPhone !== null || original.candidateEmailAuthorizedAt !== null ||
    original.candidateEmailAuthorizedBy !== null || original.checklistProfileId === "demo-controller" ||
    String(original.orchestrationCheckpoint ?? "").startsWith("demo-controller") ||
    /\[demo-controller-run:/i.test(String(original.notes ?? "")) ||
    row.checklistProfileId === "demo-controller" ||
    row.candidateEmailAuthorizedBy === "demo-controller" ||
    /\[demo-controller-run:/i.test(row.notes ?? "")) return null;
  if (verifyCurrentIdentity && (
    !row.workerName?.trim() || row.workerName === original.workerName ||
    !candidateEmailDeliveryDecision({ workerEmail: row.workerEmail ?? "" }).allowed ||
    a.identityFingerprint !== operationalIdentityFingerprint(row as typeof onbCases.$inferSelect))) return null;
  return a;
}

export const isRestrictedHistoricalCase = (row: RecordLike) => sourceHistorical(row) && !activationRecord(row);
export const isRestrictedOfflineCase = (row: RecordLike) => sourceOffline(row as Parameters<typeof sourceOffline>[0]) && !activationRecord(row);
export const isRestrictedControllerCase = (row: RecordLike) => sourceController(row) && !activationRecord(row);
export const isRestrictedUatKeyCase = (row: RecordLike) => sourceUat(row as Parameters<typeof sourceUat>[0]) && !activationRecord(row);
/** Original provenance remains true; current actual contact eligibility is separate. */
export function operationalCandidateEmailEligible(row: RecordLike): boolean {
  return (!sourceHistorical(row) || Boolean(activationRecord(row))) &&
    candidateEmailDeliveryDecision({ workerEmail: row.workerEmail ?? "" }).allowed;
}

/**
 * Live membership/permission, actual run ownership, identity and current case
 * policy binding. Called under existing write/dispatch fences; no effects.
 */
export function operationalWorkflowHasStarted(row: RecordLike): boolean {
  const a = activationRecord(row);
  return Boolean(a && a.workflowStartedByUserId === a.activatedByUserId &&
    a.workflowStartedAt && Number.isFinite(Date.parse(a.workflowStartedAt)) &&
    Number.isSafeInteger(a.workflowStartDecisionId) && a.workflowStartDecisionId! < 0);
}

export async function operationalEligibilityInTransaction(tx: OnboardingDbTransaction,
  row: typeof onbCases.$inferSelect, options: { requireStarted?: boolean } = {}): Promise<{ allowed: boolean; reason: string | null }> {
  if (!sourceHistorical(row)) return { allowed: true, reason: null };
  const a = activationRecord(row);
  if (!a) return { allowed: false, reason: "This historical record has no valid named-user operational activation." };
  const prepared = row.operationalPreparation;
  if (!prepared || prepared.organizationId !== row.organizationId || prepared.caseId !== row.id ||
    prepared.sourceKey !== a.sourceKey || prepared.sourceFingerprint !== a.sourceFingerprint ||
    prepared.revision !== a.preparationRevision)
    return { allowed: false, reason: "Operational preparation changed or is missing. Review and explicitly reconfirm the current revision before continuing." };
  const settings = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, row.organizationId), like(onbSettings.key, "onboarding-uat.run.v1:%"),
  ));
  for (const s of settings) {
    try {
      const run = JSON.parse(s.value);
      if (!run || typeof run.runId !== "string" || !Array.isArray(run.linkedCaseIds) ||
        !run.linkedCaseIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) ||
        run.linkedCaseIds.includes(row.id)) return { allowed: false, reason: "Actual or uncertain UAT run ownership remains isolated." };
    } catch { return { allowed: false, reason: "Malformed UAT ownership requires reconciliation." }; }
  }
  if (!await recordedHumanPermissionDecisionCurrent(tx, row.organizationId, a.permissionDecisionId,
    ["flow.case.read", "data.case.profile.read", "data.case.notes.read",
      "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read",
      "flow.case.edit", "data.case.profile.edit", "data.case.notes.edit", "data.identity.edit",
      "data.medical.edit", "data.payroll.edit", "data.bgv.edit"],
    a.preparationRevision, row.id, a.activatedByUserId))
    return { allowed: false, reason: "The activating named user's current case or sensitive-field permissions have ended. A fresh named review is required." };
  if (a.policyFingerprint !== canonicalIntakeHash({
    workforceContext: row.workforceContext, processPolicySnapshot: row.processPolicySnapshot,
  })) return { allowed: false, reason: "The operational policy/context binding changed. Review the current requirements and reconfirm before resuming." };
  if (options.requireStarted && (!operationalWorkflowHasStarted(row) ||
    !await recordedHumanPermissionDecisionCurrent(tx, row.organizationId, a.workflowStartDecisionId!,
      ["flow.case.edit", "tool.workflow.run", "tool.external.dispatch"],
      a.preparationRevision, row.id, a.workflowStartedByUserId!)))
    return { allowed: false, reason: "Start the operational workflow explicitly with current named-user workflow and external-dispatch permissions. Activation alone permits no delivery or background execution." };
  return { allowed: true, reason: null };
}

/** Old receipts, uploads, tokens and simulated history cannot release new work. */
export function evidenceBelongsToOperationalGeneration(
  row: RecordLike, createdAt: Date | string, id?: number | string, kind?: string,
): boolean {
  const a = activationRecord(row);
  if (!sourceHistorical(row)) return true;
  return Boolean(a && Number.isFinite(new Date(createdAt).getTime()) &&
    new Date(createdAt).getTime() >= Date.parse(a.generationStartedAt ?? a.activatedAt) &&
    (id === undefined || kind === undefined || (
      !snapshotContainsChild(a.sourceSnapshot.retainedRecords, kind, id) &&
      !(a.previousGenerations ?? []).some(item => snapshotContainsChild(item.retainedRecords, kind, id)))));
}

/** Current work reads exclude retained children; source history is never deleted. */
export function currentOperationalRecordSql(organizationId: SQLWrapper, caseId: SQLWrapper, createdAt: SQLWrapper) {
  const column = createdAt as AnyColumn;
  const table = column.table;
  const name = table && getTableName(table);
  const kind = name && HISTORICAL_CHILDREN[name as keyof typeof HISTORICAL_CHILDREN];
  const columns = table ? getTableColumns(table) : {};
  const idColumn = columns.id ?? columns.idHash;
  // A missing table or child identifier cannot prove a post-activation record.
  const priorChild = kind && idColumn ? sql`(
    exists (
      select 1 from jsonb_array_elements(coalesce(
        generation_case.operational_activation->'sourceSnapshot'->'retainedRecords'->${kind},
        '[]'::jsonb)) historic_child(value)
      where coalesce(historic_child.value->>'id', historic_child.value->>'idHash') = (${idColumn})::text
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(
        generation_case.operational_activation->'previousGenerations', '[]'::jsonb)) former(value)
      cross join lateral jsonb_array_elements(coalesce(
        former.value->'retainedRecords'->${kind}, '[]'::jsonb)) historic_child(value)
      where coalesce(historic_child.value->>'id', historic_child.value->>'idHash') = (${idColumn})::text
    )
  )` : sql`true`;
  return sql`not exists (
    select 1 from ${onbCases} generation_case
    where generation_case.organization_id = ${organizationId}
      and generation_case.id = ${caseId}
      and generation_case.operational_activation is not null
      and (${priorChild} or ${createdAt} is null or ${createdAt} <
         coalesce(generation_case.operational_activation->>'generationStartedAt',
           generation_case.operational_activation->>'activatedAt')::timestamptz)
  )`;
}
