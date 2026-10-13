import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { onbCases, onbEvents, onbSensitiveLifecyclePolicies, onbApprovals, onbCommunications,
  onbDocuments, onbSystemChecks, onbEffectJournal, onbCandidateLinks, onbCandidateSessions,
  onbCandidateUploads, onbEarlyTenureSurveyResponses, onbEmploymentOutcomeEvidence,
  type OnbWorkforceContext } from "@workspace/db";
import { hasHumanPermissions, recordHumanPermissionDecision } from "../human-permissions";
import { acquireCaseDispatchMutationLock, hasActiveCaseDispatchMarker } from "./dispatch-guard";
import { canonicalIntakeHash, findHroTemplate, hroRequestForRow } from "./hro-batch-templates";
import {
  actualRunOwnsCase, preparationSource, validStoredPreparation, preparationInputIssues,
  PREPARATION_EDIT_KEYS, PreparationError,
} from "./offline-preparation";
import { resolveEffectiveWorkforcePolicyInTransaction } from "./checklist-profiles";
import { normalizedWorkforceContext } from "./workforce-policies";
import { evaluateCaseDerivedLifecycleGateInTransaction } from "./sensitive-lifecycle";
import { candidateEmailDeliveryDecision } from "./channel-routing";
import { operationalIdentityFingerprint, activationRecord, currentOperationalRecordSql,
  operationalEligibilityInTransaction, operationalWorkflowHasStarted } from "./operational-eligibility";
import { readinessFromChecklist, type OnboardingDbTransaction } from "./settings";
import { governanceSnapshotForNewCase, withGovernanceDecisionSnapshot } from "./governance-runtime";
// Public activation remains closed until the unfinished historical-evidence,
// cross-family and provider-generation integration checks pass. The transaction
// can be exercised directly only by the owned-database test harness meanwhile.
export const OFFLINE_OPERATIONAL_BOUNDARY_READY = false;
export const OPERATIONAL_START_KEYS = [...PREPARATION_EDIT_KEYS,
  "tool.workflow.run", "tool.external.dispatch"] as const;

/** Separate explicit start; the route wakes the native engine after commit. */
export async function startOfflineWorkflowInTransaction(tx: OnboardingDbTransaction, input: {
  organizationId: string; caseId: number; actorUserId: string; expectedRevision: number;
  requirementsFingerprint: string; confirmStart: boolean;
}) {
  await acquireCaseDispatchMutationLock(tx, input.organizationId, input.caseId);
  const [row] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
  )).for("update");
  if (!row) throw new PreparationError(404, "Case not found.");
  const activation = activationRecord(row);
  const eligibility = await operationalEligibilityInTransaction(tx, row);
  if (!activation || !eligibility.allowed)
    throw new PreparationError(409, eligibility.reason || "Explicit current activation is required.");
  if (input.actorUserId !== activation.activatedByUserId)
    throw new PreparationError(409, "Reconfirm the current requirements as the acting named user before starting or resuming this workflow.");
  if (!await hasHumanPermissions(tx, { ...input, requiredKeys: OPERATIONAL_START_KEYS }))
    throw new PreparationError(403, "Current named-user case, sensitive-field, workflow-run and external-dispatch permissions are required.");
  const p = await activationPrerequisites(tx, row, true);
  if (!input.confirmStart || p.draft?.revision !== input.expectedRevision ||
    p.fingerprint !== input.requirementsFingerprint)
    throw new PreparationError(409, "Reload and explicitly confirm the current operational workflow start.");
  if (p.blockers.length || p.workflowBlocker)
    throw new PreparationError(409, [...p.blockers, p.workflowBlocker].filter(Boolean).join(" "));
  if (operationalWorkflowHasStarted(row))
    throw new PreparationError(409, "This generation was already started. Use its normal approval and resume controls; it cannot be launched again.");
  if (await hasActiveCaseDispatchMarker(tx, row.organizationId, row.id) ||
    row.orchestrationClaimUntil && row.orchestrationClaimUntil > new Date())
    throw new PreparationError(409, "Current work must be reconciled before a fresh start.");
  const [unresolved] = await tx.select({ key: onbEffectJournal.logicalOperationKey }).from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, row.organizationId), eq(onbEffectJournal.caseId, row.id),
    sql`${onbEffectJournal.status} in ('dispatching', 'unknown_effect_manual_repair')`,
  )).limit(1);
  if (unresolved) throw new PreparationError(409, "Reconcile the existing ambiguous effect before resuming; starting never replays it.");
  const receipt = await recordHumanPermissionDecision(tx, {
    ...input, requiredKeys: OPERATIONAL_START_KEYS, reviewedRevision: activation.preparationRevision,
    evidenceGeneration: activation.preparationRevision, decision: "offline-example-explicit-workflow-start",
  });
  const [{ at }] = await tx.select({ at: sql<Date>`clock_timestamp()` }).from(onbCases)
    .where(eq(onbCases.id, row.id));
  const now = new Date(at);
  const [saved] = await tx.update(onbCases).set({
    operationalActivation: { ...activation, workflowStartedAt: now.toISOString(),
      workflowStartedByUserId: input.actorUserId, workflowStartDecisionId: receipt.id },
    updatedAt: now,
  }).where(and(eq(onbCases.organizationId, row.organizationId), eq(onbCases.id, row.id))).returning();
  await tx.insert(onbEvents).values({
    organizationId: row.organizationId, caseId: row.id, agent: "human", engine: "operational-activation",
    title: "Operational workflow explicitly started",
    detail: `Named-user permission decision ${receipt.id} authorized the current generation. Historical checkpoints, approvals and effects remain excluded.`,
    createdAt: now, idempotencyKey: `operational-start:${row.id}:${activation.generation}:${receipt.id}`,
  });
  return saved!;
}

/** Existing native adapters only. Other domains disclose their missing executor. */
export function familyWorkflowBlocker(templateId: string): string | null {
  const template = findHroTemplate(templateId);
  if (!template) return "Current family requirements are unavailable.";
  if (template.hireType) return null;
  if (template.family === "Offboarding")
    return "Use the dedicated separation policy and workstream controls. Final closure requires supplied and approved section 4.6; the onboarding engine must not execute this request.";
  return `${template.family}: the existing intake contract is review-only. An approved family execution/closure adapter and its configured ${template.family === "Payroll" ? "payroll" : template.family === "Benefits" ? "benefits" : "domain"} connector are required; no onboarding executor or simulated transaction will be substituted.`;
}

export async function activationPrerequisites(tx: OnboardingDbTransaction, row: typeof onbCases.$inferSelect, reconfirm = false) {
  const source = preparationSource(row);
  const draft = validStoredPreparation(row);
  const template = draft ? findHroTemplate(draft.templateId) : undefined;
  const blockers: string[] = [];
  if (!source || !draft || !template) blockers.push("Save a valid operational preparation revision first.");
  if (row.operationalActivation && !reconfirm) blockers.push("This case is already activated; historical workflow start cannot be replayed.");
  if (reconfirm && !activationRecord(row, false)) blockers.push("A valid retained activation is required for a fresh named review.");
  if (await actualRunOwnsCase(tx, row)) blockers.push("Actual or uncertain UAT run ownership remains isolated.");
  const data = { ...draft?.data };
  if (reconfirm && draft?.revision === row.operationalActivation?.preparationRevision) Object.assign(data, {
    worker_name: row.workerName, worker_email: row.workerEmail, role: row.role,
    department: row.department, legal_entity: row.legalEntity, manager_name: row.managerName,
    recruiter_name: row.recruiterName, joining_date: row.joiningDate,
    work_country: row.workforceContext.workCountry || data.work_country,
  });
  if (template) blockers.push(...preparationInputIssues(template.id, data).map(i => `${i.column}: ${i.message}`));
  if (!candidateEmailDeliveryDecision({ workerEmail: data.worker_email ?? "" }).allowed)
    blockers.push("A real deliverable worker email is required, not a fixture or reserved domain.");
  if (!data.worker_name?.trim() || data.worker_name === source?.values.workerName ||
    /^(example|fictional|sample)(?:\s|—|:|-)/i.test(data.worker_name))
    blockers.push("Replace the fictional source name with the actual worker identity.");
  if (/^(?:FICTIONAL|SAMPLE|EXAMPLE|UAT)[-_:]/i.test(data.request_id ?? ""))
    blockers.push("Supply the actual source request reference; a fixture reference cannot establish a real request.");
  const workforceContext = normalizedWorkforceContext({
    workCountry: data.work_country, legalEntity: data.legal_entity,
    workerCategory: data.worker_category || "employee", workEnvironment: (data.work_environment || "office") as OnbWorkforceContext["workEnvironment"],
    site: data.site,
    siteExposure: data.site_exposure === "yes" ? true : data.site_exposure === "no" ? false : undefined,
    safetyCritical: data.safety_critical === "yes" ? true : data.safety_critical === "no" ? false : undefined,
    assistedIntake: data.assisted_intake === "yes" ? true : data.assisted_intake === "no" ? false : undefined,
  });
  const collection = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
    organizationId: row.organizationId, jurisdiction: data.work_country || null,
  });
  if (!collection.allowed) blockers.push(collection.reason);
  const base = {
    hireType: template?.hireType ?? "service-request", workerCategory: data.worker_category || "employee",
    workerBand: null, role: data.role || template?.name || "HR request", department: data.department || "",
    geography: data.work_country || "", legalEntity: data.legal_entity || "",
  };
  const policy = template?.hireType
    ? await resolveEffectiveWorkforcePolicyInTransaction(tx, row.organizationId, workforceContext, base)
    : null;
  const currentPolicies = await tx.select({
    id: onbSensitiveLifecyclePolicies.id, revision: onbSensitiveLifecyclePolicies.revision,
    approval: onbSensitiveLifecyclePolicies.approvedAuthorityAssignmentId,
  }).from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, row.organizationId),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, data.work_country || ""),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
  ));
  const fingerprint = canonicalIntakeHash({
    caseId: row.id, organizationId: row.organizationId, preparation: draft, data,
    currentVersion: row.updatedAt, currentFacts: operationalIdentityFingerprint(row),
    currentPolicy: row.processPolicySnapshot, currentActivation: row.operationalActivation?.generation ?? null,
    template, policy, collection, currentPolicies: currentPolicies.sort((a, b) => a.id - b.id),
  });
  return { blockers, fingerprint, data, template, source, draft, workforceContext, policy, base,
    workflowBlocker: template ? familyWorkflowBlocker(template.id) : "Current family template is unavailable." };
}

export async function activateOfflineCaseInTransaction(tx: OnboardingDbTransaction, input: {
  organizationId: string; caseId: number; actorUserId: string; expectedRevision: number;
  requirementsFingerprint: string; confirmIdentity: boolean; confirmSourceEvidenceExcluded: boolean;
  reconfirm?: boolean;
}) {
  await acquireCaseDispatchMutationLock(tx, input.organizationId, input.caseId);
  const [row] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
  )).for("update");
  if (!row) throw new PreparationError(404, "Case not found.");
  if (!await hasHumanPermissions(tx, { ...input, requiredKeys: PREPARATION_EDIT_KEYS }))
    throw new PreparationError(403, "Activation requires current named-member case, profile and sensitive-field permissions. Shared Demo accounts cannot activate.");
  const p = await activationPrerequisites(tx, row, input.reconfirm);
  if (!p.draft || p.draft.revision !== input.expectedRevision || p.fingerprint !== input.requirementsFingerprint)
    throw new PreparationError(409, "Preparation or current requirements changed. Reload and review before confirming.");
  if (!input.confirmIdentity || !input.confirmSourceEvidenceExcluded)
    throw new PreparationError(400, "Explicit actual-identity and historical-evidence exclusion confirmations are required.");
  if (p.blockers.length) throw new PreparationError(409, p.blockers.join(" "));
  if (await hasActiveCaseDispatchMarker(tx, input.organizationId, input.caseId) ||
    row.orchestrationClaimUntil && row.orchestrationClaimUntil > new Date())
    throw new PreparationError(409, "Reconcile active or ambiguous work before activating.");
  const [unresolved] = await tx.select({ id: onbEffectJournal.logicalOperationKey }).from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, row.organizationId), eq(onbEffectJournal.caseId, row.id),
    sql`${onbEffectJournal.status} in ('dispatching', 'unknown_effect_manual_repair')`,
  )).limit(1);
  if (unresolved) throw new PreparationError(409, "A retained ambiguous effect needs independent reconciliation; activation never replays it.");
  const [{ at }] = await tx.select({ at: sql<Date>`clock_timestamp()` }).from(onbCases)
    .where(eq(onbCases.id, row.id));
  const now = new Date(at);
  const prior = row.operationalActivation;
  const sameGeneration = input.reconfirm && prior &&
    prior.preparationRevision === p.draft.revision &&
    prior.identityFingerprint === operationalIdentityFingerprint(row) &&
    prior.policyFingerprint === canonicalIntakeHash({
      workforceContext: row.workforceContext, processPolicySnapshot: row.processPolicySnapshot,
    });
  if (sameGeneration) {
    const receipt = await recordHumanPermissionDecision(tx, {
      ...input, requiredKeys: PREPARATION_EDIT_KEYS, reviewedRevision: p.draft.revision,
      evidenceGeneration: p.draft.revision, decision: "offline-example-operational-reconfirmation",
    });
    const [saved] = await tx.update(onbCases).set({
      operationalActivation: { ...prior, activatedByUserId: input.actorUserId, permissionDecisionId: receipt.id,
        ...(prior.activatedByUserId !== input.actorUserId ? {
          workflowStartedAt: undefined, workflowStartedByUserId: undefined, workflowStartDecisionId: undefined,
        } : {}) },
      createdByUserId: input.actorUserId, updatedAt: now,
    }).where(and(eq(onbCases.organizationId, row.organizationId), eq(onbCases.id, row.id))).returning();
    await tx.insert(onbEvents).values({
      organizationId: row.organizationId, caseId: row.id, agent: "human", engine: "operational-activation",
      title: "Current operational bindings reviewed",
      detail: "Current named authorization renewed. No workflow, approval or external effect was started.",
      idempotencyKey: `operational-reconfirmation:${row.id}:${receipt.id}`, createdAt: now,
    });
    return saved!;
  }
  // Never reset a workflow around an already confirmed remote operation.
  // Reconfirmation of unchanged facts above is safe; identity/policy rebases
  // need explicit remote reconciliation before their new generation can start.
  const [confirmed] = await tx.select({ key: onbEffectJournal.logicalOperationKey }).from(onbEffectJournal).where(and(
    eq(onbEffectJournal.organizationId, row.organizationId), eq(onbEffectJournal.caseId, row.id),
    eq(onbEffectJournal.status, "confirmed"),
  )).limit(1);
  if (confirmed) throw new PreparationError(409,
    "Confirmed external work is retained on this reference. Reconcile its current identity and policy binding through the normal controls before changing the operational generation; activation never replays confirmed operations.");
  const generation = randomUUID();
  // Preserve immutable source projections before freeing only the old runtime
  // uniqueness keys. Rows, IDs, uploads, provider outcomes and decision history
  // remain in place; their dates keep them out of current work.
  const retained = {
    approvals: await tx.select().from(onbApprovals).where(and(eq(onbApprovals.organizationId, row.organizationId), eq(onbApprovals.caseId, row.id), currentOperationalRecordSql(onbApprovals.organizationId, onbApprovals.caseId, onbApprovals.createdAt))).for("update"),
    communications: await tx.select().from(onbCommunications).where(and(eq(onbCommunications.organizationId, row.organizationId), eq(onbCommunications.caseId, row.id), currentOperationalRecordSql(onbCommunications.organizationId, onbCommunications.caseId, onbCommunications.createdAt))).for("update"),
    documents: await tx.select().from(onbDocuments).where(and(eq(onbDocuments.organizationId, row.organizationId), eq(onbDocuments.caseId, row.id), currentOperationalRecordSql(onbDocuments.organizationId, onbDocuments.caseId, onbDocuments.createdAt))).for("update"),
    systemChecks: await tx.select().from(onbSystemChecks).where(and(eq(onbSystemChecks.organizationId, row.organizationId), eq(onbSystemChecks.caseId, row.id), currentOperationalRecordSql(onbSystemChecks.organizationId, onbSystemChecks.caseId, onbSystemChecks.createdAt))).for("update"),
    events: await tx.select().from(onbEvents).where(and(eq(onbEvents.organizationId, row.organizationId), eq(onbEvents.caseId, row.id), currentOperationalRecordSql(onbEvents.organizationId, onbEvents.caseId, onbEvents.createdAt))).for("update"),
    candidateLinks: await tx.select().from(onbCandidateLinks).where(and(eq(onbCandidateLinks.organizationId, row.organizationId), eq(onbCandidateLinks.caseId, row.id), currentOperationalRecordSql(onbCandidateLinks.organizationId, onbCandidateLinks.caseId, onbCandidateLinks.createdAt))).for("update"),
    candidateSessions: await tx.select().from(onbCandidateSessions).where(and(eq(onbCandidateSessions.organizationId, row.organizationId), eq(onbCandidateSessions.caseId, row.id), currentOperationalRecordSql(onbCandidateSessions.organizationId, onbCandidateSessions.caseId, onbCandidateSessions.createdAt))).for("update"),
    candidateUploads: await tx.select().from(onbCandidateUploads).where(and(eq(onbCandidateUploads.organizationId, row.organizationId), eq(onbCandidateUploads.caseId, row.id), currentOperationalRecordSql(onbCandidateUploads.organizationId, onbCandidateUploads.caseId, onbCandidateUploads.createdAt))).for("update"),
    surveyResponses: await tx.select().from(onbEarlyTenureSurveyResponses).where(and(eq(onbEarlyTenureSurveyResponses.organizationId, row.organizationId), eq(onbEarlyTenureSurveyResponses.caseId, row.id), currentOperationalRecordSql(onbEarlyTenureSurveyResponses.organizationId, onbEarlyTenureSurveyResponses.caseId, onbEarlyTenureSurveyResponses.createdAt))).for("update"),
    employmentEvidence: await tx.select().from(onbEmploymentOutcomeEvidence).where(and(eq(onbEmploymentOutcomeEvidence.organizationId, row.organizationId), eq(onbEmploymentOutcomeEvidence.caseId, row.id), currentOperationalRecordSql(onbEmploymentOutcomeEvidence.organizationId, onbEmploymentOutcomeEvidence.caseId, onbEmploymentOutcomeEvidence.createdAt))).for("update"),
  };
  const archiveLabel = prior ? "prior-operation" : "source-history";
  for (const item of retained.approvals) if (item.idempotencyKey)
    await tx.update(onbApprovals).set({ idempotencyKey: `${archiveLabel}:${generation}:${item.id}:${item.idempotencyKey}` }).where(eq(onbApprovals.id, item.id));
  for (const item of retained.communications) if (item.idempotencyKey)
    await tx.update(onbCommunications).set({ idempotencyKey: `${archiveLabel}:${generation}:${item.id}:${item.idempotencyKey}` }).where(eq(onbCommunications.id, item.id));
  for (const item of retained.documents)
    await tx.update(onbDocuments).set({ key: `${archiveLabel}:${generation}:${item.id}:${item.key}` }).where(eq(onbDocuments.id, item.id));
  for (const item of retained.systemChecks)
    await tx.update(onbSystemChecks).set({ system: `${archiveLabel}:${generation}:${item.id}:${item.system}` }).where(eq(onbSystemChecks.id, item.id));
  for (const item of retained.events) if (item.idempotencyKey)
    await tx.update(onbEvents).set({ idempotencyKey: `${archiveLabel}:${generation}:${item.id}:${item.idempotencyKey}` }).where(eq(onbEvents.id, item.id));
  // Do not carry candidate credentials across either initial activation or a
  // material rebase, even when a simulated expiry date is in the future.
  await tx.update(onbCandidateLinks).set({ revokedAt: now }).where(and(
    eq(onbCandidateLinks.organizationId, row.organizationId), eq(onbCandidateLinks.caseId, row.id),
  ));
  await tx.update(onbCandidateSessions).set({ expiresAt: now }).where(and(
    eq(onbCandidateSessions.organizationId, row.organizationId), eq(onbCandidateSessions.caseId, row.id),
  ));
  const governance = await governanceSnapshotForNewCase(row.organizationId, now, tx);
  const receipt = await recordHumanPermissionDecision(tx, {
    ...input, requiredKeys: PREPARATION_EDIT_KEYS, reviewedRevision: p.draft.revision,
    evidenceGeneration: p.draft.revision, decision: "offline-example-operational-activation",
  });
  const currentFields: Partial<typeof onbCases.$inferInsert> = {
    ...p.base, workerName: p.data.worker_name, workerEmail: p.data.worker_email,
    workerPhone: prior ? row.workerPhone : null, channelPreference: prior ? row.channelPreference : "email", managerName: p.data.manager_name || "",
    recruiterName: p.data.recruiter_name || "", joiningDate: p.data.joining_date || p.data.effective_date,
    workforceContext: p.workforceContext, workforceContextVersion: row.workforceContextVersion + 1,
    workforceClassification: p.policy?.classification ?? null,
    checklistSnapshot: p.policy?.effectiveItems ?? [],
    checklistProfileId: p.policy?.profile.profileId ?? "hro-intake-held",
    checklistProfileName: p.policy?.profile.profileName ?? `${p.template!.family} operational intake`,
    checklistProfileVersion: p.policy?.profile.profileVersion ?? 1,
    checklistMatchedCriteria: p.policy?.profile.matchedCriteria ?? {},
    checklistMatchExplanation: p.policy?.profile.explanation ?? "Current family intake requires its dedicated reviewed executor.",
    processPolicySnapshot: withGovernanceDecisionSnapshot({
      profileId: p.policy?.profile.profileId ?? "hro-intake-held",
      profileVersion: p.policy?.profile.profileVersion ?? 1,
      processPolicy: p.policy?.profile.processPolicy ?? {},
      batchIntake: hroRequestForRow(p.template!, p.data),
      specialistReviewOnly: !p.template!.hireType,
    }, governance),
    readiness: readinessFromChecklist(p.policy?.effectiveItems ?? []), workstreams: [],
    orchestrationStatus: p.template!.hireType ? "idle" : "hro-request-pending-review",
    orchestrationCheckpoint: null, orchestrationClaimOwner: null, orchestrationClaimUntil: null,
    lifecycleStage: "trigger-received", createdByUserId: input.actorUserId,
    offerAcceptanceComplete: false, offerAcceptanceCompletedAt: null, offerAcceptanceCompletedBy: null,
    candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
    notes: "Operational identity recorded. Original fictional source is retained separately and is not employee evidence.",
    createdAt: now, updatedAt: now,
  };
  const activation = {
    schema: "offline-case-activation/v1" as const, organizationId: row.organizationId, caseId: row.id,
    sourceKey: p.source!.key, sourceFingerprint: canonicalIntakeHash(p.source!.values),
    sourceSnapshot: prior?.sourceSnapshot ?? JSON.parse(JSON.stringify({ ...row, retainedRecords: retained })) as Record<string, unknown>,
    previousGenerations: prior ? [...(prior.previousGenerations ?? []), {
      generation: prior.generation, startedAt: prior.generationStartedAt ?? prior.activatedAt,
      identityFingerprint: prior.identityFingerprint, policyFingerprint: prior.policyFingerprint,
      permissionDecisionId: prior.permissionDecisionId, retainedRecords: JSON.parse(JSON.stringify(retained)),
    }] : [],
    generation, activatedAt: prior?.activatedAt ?? now.toISOString(), generationStartedAt: now.toISOString(), activatedByUserId: input.actorUserId,
    preparationRevision: p.draft.revision, permissionDecisionId: receipt.id,
    identityFingerprint: operationalIdentityFingerprint({ ...row, ...currentFields }),
    policyFingerprint: canonicalIntakeHash({
      workforceContext: currentFields.workforceContext, processPolicySnapshot: currentFields.processPolicySnapshot,
    }),
  };
  const [saved] = await tx.update(onbCases).set({ ...currentFields, operationalActivation: activation })
    .where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId))).returning();
  await tx.insert(onbEvents).values({
    organizationId: row.organizationId, caseId: row.id, agent: "human", engine: "operational-activation",
    title: "Named-user operational activation confirmed",
    detail: `Fresh generation ${activation.generation}; original fictional history excluded. Activation started no workflow and issued no messages, links or transactions.`,
    idempotencyKey: `operational-activation:${row.id}:${activation.generation}`,
    createdAt: now,
  });
  return saved!;
}
