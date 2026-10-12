import { customFetch } from '@workspace/api-client-react';

export type TransferBasis = 'automatic-transfer' | 'share-purchase' | 'asset-purchase' | 'cross-border';
export type Requirement = 'not-required' | 'required' | 'legal-review-required';
export type ReconciliationStream = 'migration' | 'payroll' | 'benefits' | 'access' | 'first-pay';
export type ReconciliationStatus = 'pending' | 'ready' | 'complete' | 'exception' | 'unknown-effect-manual-repair';
export type KpiMetric = 'service-date-accurate' | 'consultation-timely' | 'access-timely' | 'first-pay-accurate' | 'actual-attrition' | 'harmonisation-complete';

export type WorkforceTransferPopulation = {
  id: string; country: string; expectedHeadcount: number | null; importedHeadcount: number;
  status: string; version: number;
};
export type PathwayDecision = {
  jurisdiction: string; decision: 'approved' | 'rejected'; offerRequirement: Requirement;
  bgvApplicability: Requirement; decidedAt: string;
};
export type ConsultationMilestone = {
  id: number; jurisdiction: string; kind: string; dueAt: string; completedAt: string | null;
  status: 'planned' | 'communicated' | 'completed' | 'blocked';
};
export type IntegrationAction = {
  id: string; kind: 'induction' | 'integration' | 'harmonisation' | 'contingency-parallel-run'; ownerUserId: string;
  dueAt: string; completedAt: string | null; policyApprovedAt: string | null;
  status: 'planned' | 'in-progress' | 'completed' | 'blocked'; evidenceRecorded: boolean;
};
export type CutoverPlan = {
  id: string; version: number; workerCount: number; status: 'draft' | 'go' | 'no-go';
  readinessGeneration: number; createdAt: string; decisionAt: string | null; contingencyRecorded: boolean;
  signoffs: Array<{ role: 'hr-integration' | 'payroll' | 'it'; decision: 'approved' | 'blocked'; readinessGeneration: number; authorityScope: string; authorityCurrent: boolean }>;
  workerReconciliation: Array<{ workerId: string; stream: ReconciliationStream; status: ReconciliationStatus; evidenceRecorded: boolean; sourceEvidenceRecorded: boolean; destinationEvidenceRecorded: boolean; authorityScope: string; authorityCurrent: boolean }>;
};
export type WorkforceTransferProgram = {
  id: string; version: number; name: string; sourceLegalEntity: string; destinationLegalEntity: string;
  countries: string[]; proposedBasis: TransferBasis; legalDay1: string;
  owners: { hrIntegration: string; legal: string; payroll: string; it: string };
  status: string; createdAt: string; readCapabilities?: Array<'hr' | 'legal' | 'payroll' | 'it'>; populations: WorkforceTransferPopulation[];
  pathways: PathwayDecision[]; consultation: ConsultationMilestone[];
  integrationActions: IntegrationAction[]; cutoverPlans: CutoverPlan[];
};
export type WorkforceTransferProgramInput = Omit<WorkforceTransferProgram,
  'id' | 'version' | 'status' | 'createdAt' | 'populations' | 'pathways' | 'consultation' | 'integrationActions' | 'cutoverPlans'>;

export type TransferWorker = {
  id: string; migrationStatus: string; objectionStatus: 'pending' | 'objected' | 'withdrawn' | 'resolved';
  version: number;
};
export type PopulationReconciliation = {
  populationId: string; expectedHeadcount: number | null; importedHeadcount: number;
  migrationCounts: Record<string, number>; workers: TransferWorker[];
};
export type ImportPreviewResult = {
  previewId: string; validCount: number; invalidCount: number;
  errors: Array<{ row: number; field: string; message: string }>; mapping: Record<string, string>;
};
export type KpiSummary = {
  id: KpiMetric; value: number | null; status: 'not-collected' | 'insufficient-data' | 'measured';
  sampleSize: number; eligibleCount: number | null; unknownCount: number | null; note: string;
};

const json = <T,>(url: string, method: 'GET' | 'POST', body?: unknown, options?: RequestInit) =>
  customFetch<T>(url, {
    ...options, method, responseType: 'json',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', ...options?.headers }, body: JSON.stringify(body) }),
  });
const programUrl = (id: string) => `/api/onboarding/workforce-transfers/programs/${encodeURIComponent(id)}`;

export type WorkforceTransferProgramSummary = Omit<WorkforceTransferProgram, 'owners' | 'populations' | 'pathways' | 'consultation' | 'integrationActions' | 'cutoverPlans'> & {
  hrIntegrationOwner: string | null;
  partialCountryScope: boolean;
  populationSummary: { importedHeadcount: number; expectedHeadcount: number | null };
};
export const listWorkforceTransferPrograms = (options?: RequestInit) =>
  json<WorkforceTransferProgramSummary[]>(
    '/api/onboarding/workforce-transfers/programs', 'GET', undefined, options);
export const getWorkforceTransferProgram = (id: string, options?: RequestInit) => json<WorkforceTransferProgram>(programUrl(id), 'GET', undefined, options);
export const createWorkforceTransferProgram = (data: WorkforceTransferProgramInput, options?: RequestInit) => json<{ id: string; version: number }>(
  '/api/onboarding/workforce-transfers/programs', 'POST', data, options);
export const recordPathwayDecision = (id: string, data: { expectedVersion: number; jurisdiction: string; decision: 'approved' | 'rejected'; offerRequirement: Requirement; bgvApplicability: Requirement; reviewReference: string }, options?: RequestInit) =>
  json<{ version: number; status: string }>(`${programUrl(id)}/pathways`, 'POST', data, options);
export const recordDataGovernance = (id: string, data: { expectedVersion: number; jurisdiction: string; lawfulBasisReference: string; retentionReference: string; retentionUntil: string }, options?: RequestInit) =>
  json<{ version: number }>(`${programUrl(id)}/data-governance`, 'POST', data, options);
export const createPopulation = (id: string, data: { country: string; sourceLegalEntity?: string; destinationLegalEntity?: string; expectedHeadcount?: number }, options?: RequestInit) =>
  json<{ id: string; version: number }>(`${programUrl(id)}/populations`, 'POST', data, options);
export const previewImport = (populationId: string, data: { mapping: Record<string, string>; rows: Record<string, string>[] }, options?: RequestInit) =>
  json<ImportPreviewResult>(`/api/onboarding/workforce-transfers/populations/${encodeURIComponent(populationId)}/imports/preview`, 'POST', data, options);
export const persistImport = (populationId: string, data: { previewId: string; idempotencyKey: string; expectedPopulationVersion: number }, options?: RequestInit) =>
  json<{ importId: string; retry: boolean; importedCount: number; workers: Array<{ stableSourceId: string; id: string }> }>(`/api/onboarding/workforce-transfers/populations/${encodeURIComponent(populationId)}/imports`, 'POST', data, options);
export const getPopulationReconciliation = (populationId: string, options?: RequestInit) =>
  json<PopulationReconciliation>(`/api/onboarding/workforce-transfers/populations/${encodeURIComponent(populationId)}/reconciliation`, 'GET', undefined, options);
export const recordConsultationMilestone = (id: string, data: { expectedVersion: number; milestoneId?: number; jurisdiction: string; kind: string; dueAt: string; completedAt?: string; status: 'planned' | 'communicated' | 'completed' | 'blocked'; evidenceReference: string }, options?: RequestInit) =>
  json<{ milestoneId: string; version: number }>(`${programUrl(id)}/consultation-milestones`, 'POST', data, options);
export const recordWorkerObjection = (workerId: string, data: { expectedWorkerVersion: number; outcome: TransferWorker['objectionStatus']; receivedAt: string; evidenceReference: string }, options?: RequestInit) =>
  json<{ workerId: string; version: number; objectionStatus: string }>(`/api/onboarding/workforce-transfers/workers/${encodeURIComponent(workerId)}/objections`, 'POST', data, options);
export const recordIntegrationAction = (id: string, data: { expectedVersion: number; actionId?: string; kind: IntegrationAction['kind']; ownerUserId: string; dueAt: string; completedAt?: string; status?: IntegrationAction['status']; evidenceReference?: string; legalApprovalReference?: string }, options?: RequestInit) =>
  json<{ actionId: string; version: number }>(`${programUrl(id)}/integration-actions`, 'POST', data, options);
export const createCutoverPlan = (id: string, data: { expectedVersion: number; contingencyReference?: string }, options?: RequestInit) =>
  json<{ planId: string; version: number; programVersion: number; workerCount: number }>(`${programUrl(id)}/cutover-plans`, 'POST', data, options);
export const recordWorkerReconciliation = (planId: string, workerId: string, data: { expectedPlanVersion: number; stream: ReconciliationStream; status: ReconciliationStatus; evidenceReference: string; sourceAttestationReference?: string; destinationAttestationReference?: string; destinationOriginalHireDate?: string; destinationContinuousServiceDate?: string; destinationTermsReference?: string; destinationBenefitsReference?: string; repairReference?: string }, options?: RequestInit) =>
  json<{ planId: string; version: number; stream: string; status: string }>(`/api/onboarding/workforce-transfers/cutover-plans/${encodeURIComponent(planId)}/workers/${encodeURIComponent(workerId)}/reconciliation`, 'POST', data, options);
export const recordSignoff = (planId: string, data: { expectedPlanVersion: number; role: 'hr-integration' | 'payroll' | 'it'; decision: 'approved' | 'blocked'; reasonReference: string }, options?: RequestInit) =>
  json<{ planId: string; version: number; role: string; decision: string }>(`/api/onboarding/workforce-transfers/cutover-plans/${encodeURIComponent(planId)}/signoffs`, 'POST', data, options);
export const recordGoNoGo = (planId: string, data: { expectedPlanVersion: number; decision: 'go' | 'no-go' }, options?: RequestInit) =>
  json<{ planId: string; status: string; version: number; programVersion: number; note: string }>(`/api/onboarding/workforce-transfers/cutover-plans/${encodeURIComponent(planId)}/go-no-go`, 'POST', data, options);
export const recordKpiDefinition = (id: string, data: { metric: KpiMetric; definitionReference: string; denominatorReference: string }, options?: RequestInit) =>
  json<{ programId: string; metric: KpiMetric; revision: number; eligibleCount: number }>(`${programUrl(id)}/kpi-definitions`, 'POST', data, options);
export const recordKpiEvidence = (id: string, data: { metric: KpiMetric; occurredAt: string; measurement: Record<string, string | number | boolean>; sourceAttestationReference: string; evidenceReference: string; sourceRecordId: string; workerId?: string }, options?: RequestInit) =>
  json<{ evidenceId: string }>(`${programUrl(id)}/kpi-evidence`, 'POST', data, options);
export const getKpis = (id: string, options?: RequestInit) => json<{ programId: string; metrics: KpiSummary[] }>(`${programUrl(id)}/kpis`, 'GET', undefined, options);