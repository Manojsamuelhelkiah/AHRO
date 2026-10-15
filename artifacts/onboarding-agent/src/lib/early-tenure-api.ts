import { customFetch } from '@workspace/api-client-react';

const EARLY_TENURE_ROOT = '/api/onboarding/early-tenure';

export type EarlyTenureEvidence = {
  id: string | number;
  occurredAt?: string | null;
  source?: string | null;
  reference?: string | null;
  note?: string | null;
};

export type EarlyTenureAssignment = {
  id: string | number;
  kind: string;
  label: string;
  owner?: string | null;
  ownerUserId?: string | null;
  dueAt?: string | null;
  status: string;
  revision?: number | null;
  evidence?: EarlyTenureEvidence[];
  reminderStatus?: string | null;
  connectorStatus?: string | null;
  sourceConfirmationRequired?: boolean;
  requiredConnectorKey?: string | null;
  structuredAgenda?: string[];
  buddyAssignment?: string | null;
  buddyUserId?: string | null;
};

export type EarlyTenureCheckIn = {
  id: string | number;
  label: string;
  ownerUserId?: string | null;
  dueAt?: string | null;
  status: string;
  revision?: number | null;
  reminderStatus?: string | null;
  evidence?: EarlyTenureEvidence[];
};

export type EarlyTenureCase = {
  caseId?: number;
  snapshot?: {
    id: string | number;
    policyVersion?: number | string | null;
    plannedJoiningAt?: string | null;
    actualJoinedAt?: string | null;
    probationLengthDays?: number | null;
    anchorRevision?: number | null;
    snapshotVersion?: number | null;
  } | null;
  assignments: EarlyTenureAssignment[];
  checkIns: EarlyTenureCheckIn[];
  probationDecision?: {
    disposition?: string | null;
    decisionVersion?: number | null;
    decidedAt?: string | null;
    effectiveAt?: string | null;
    extensionEndsAt?: string | null;
    anchorRevision?: number | null;
    stale?: boolean | null;
    authority?: string | null;
  } | null;
  probation?: {
    maturityAt?: string | null;
    governedEndAt?: string | null;
  } | null;
};

export type EarlyTenurePolicy = {
  id: string | number;
  version?: number | null;
  status?: string | null;
  probationLengthDays?: number | null;
  checkInDays?: number[];
  decisionAuthorityScope?: string | null;
  applicability?: {
    hireTypes?: string[];
    workerCategories?: string[];
    legalEntities?: string[];
  } | null;
  obligations?: EarlyTenurePolicyObligation[];
  checkIns?: EarlyTenurePolicyCheckIn[];
};

export type EarlyTenurePolicyObligation = {
  key: string;
  kind: string;
  label: string;
  offsetDays: number;
  required: boolean;
  ownerRole: string;
  requireEvidence: boolean;
  connectorKey?: string;
  sourceConfirmationRequired?: boolean;
  structuredAgenda?: string[];
};

export type EarlyTenurePolicyCheckIn = {
  key: string;
  label: string;
  offsetDays: number;
  required: boolean;
  reminderLeadDays: number;
};

export type EmploymentOutcomeEvidenceWriteResponse = {
  evidenceId: number;
};

export type EarlyTenureOwnerOption = {
  userId: string;
  role: string;
};

export type EarlyTenureInboxReminder = {
  id: number;
  targetType: 'assignment' | 'checkin';
  dueAt: string;
  availableAt: string;
  label?: string | null;
  taskReference?: string | null;
  evidenceCompletionPath?: string | null;
};

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function normalizeEvidence(value: unknown): EarlyTenureEvidence {
  const source = record(value);
  return {
    id: source.id ?? source.evidenceId ?? 'unknown-evidence',
    occurredAt: source.occurredAt ?? source.occurred_at ?? source.observedAt ?? source.observed_at ?? source.recordedAt ?? source.completedAt ?? null,
    source: source.source ?? source.sourceType ?? source.provenance ?? null,
    reference: source.reference ?? source.evidenceReference ?? source.evidence_reference ?? null,
    note: source.note ?? source.detail ?? null,
  };
}

function key(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function linkedRows(rows: unknown[], targetId: unknown, targetFields: string[]): unknown[] {
  const targetKey = key(targetId);
  if (!targetKey) return [];
  return rows.filter((row) => {
    const source = record(row);
    return targetFields.some((field) => key(source[field]) === targetKey);
  });
}

function mergeEvidence(...collections: unknown[][]): EarlyTenureEvidence[] {
  const byId = new Map<string, EarlyTenureEvidence>();
  for (const value of collections.flat()) {
    const evidence = normalizeEvidence(value);
    byId.set(String(evidence.id), evidence);
  }
  return [...byId.values()];
}

function reminderStatus(reminders: unknown[], targetType: 'assignment' | 'checkin', targetId: unknown): string | null {
  const targetKey = key(targetId);
  if (!targetKey) return null;
  const reminder = reminders.find((row) => {
    const source = record(row);
    return (source.targetType ?? source.target_type) === targetType && key(source.targetId ?? source.target_id) === targetKey;
  });
  const status = record(reminder).status;
  return typeof status === 'string' ? status : null;
}

function normalizeAssignment(value: unknown, evidence: unknown[] = [], reminders: unknown[] = []): EarlyTenureAssignment {
  const source = record(value);
  return {
    id: source.id ?? source.assignmentId ?? 'unknown-assignment',
    kind: source.kind ?? source.assignmentType ?? source.type ?? 'task',
    label: source.label ?? source.title ?? source.kind ?? source.assignmentType ?? 'Early-tenure task',
    owner: source.owner ?? source.ownerName ?? source.assignee ?? null,
    ownerUserId: source.ownerUserId ?? source.owner_user_id ?? null,
    dueAt: source.dueAt ?? source.due_at ?? source.dueDate ?? null,
    status: source.status ?? 'not-started',
    revision: source.revision ?? null,
    evidence: mergeEvidence(array(source.evidence ?? source.evidences), evidence),
    reminderStatus: source.reminderStatus ?? source.reminder_status ?? reminderStatus(reminders, 'assignment', source.id ?? source.assignmentId) ?? null,
    connectorStatus: source.connectorStatus ?? source.connector_status ?? source.requiredConnectorKey ?? null,
    sourceConfirmationRequired: source.sourceConfirmationRequired === true || source.source_confirmation_required === true,
    requiredConnectorKey: source.requiredConnectorKey ?? source.required_connector_key ?? null,
    structuredAgenda: array(record(source.taskDetails).structuredAgenda).filter((item): item is string => typeof item === 'string'),
    buddyAssignment: record(source.taskDetails).buddyAssignment ?? null,
    buddyUserId: record(source.taskDetails).buddyUserId ?? record(source.taskDetails).buddy_user_id ?? null,
  };
}

function normalizeCheckIn(value: unknown, evidence: unknown[] = [], reminders: unknown[] = []): EarlyTenureCheckIn {
  const source = record(value);
  const id = source.id ?? source.checkInId;
  const directCompletionEvidence = source.evidenceReference ?? source.evidence_reference
    ? [{ id: `checkin-${String(id)}-completion`, observedAt: source.completedAt ?? source.completed_at, evidenceReference: source.evidenceReference ?? source.evidence_reference, provenance: 'human-authorized' }]
    : [];
  return {
    id: id ?? 'unknown-check-in',
    label: source.label ?? source.name ?? source.dayLabel ?? 'Policy check-in',
    ownerUserId: source.ownerUserId ?? source.owner_user_id ?? null,
    dueAt: source.dueAt ?? source.due_at ?? source.scheduledAt ?? null,
    status: source.status ?? 'not-started',
    revision: source.revision ?? null,
    reminderStatus: source.reminderStatus ?? source.reminder_status ?? reminderStatus(reminders, 'checkin', id) ?? null,
    evidence: mergeEvidence(array(source.evidence ?? source.evidences), evidence, directCompletionEvidence),
  };
}

export function normalizeEarlyTenureCase(value: unknown): EarlyTenureCase {
  const source = record(value);
  const payload = record(source.data ?? source);
  const snapshot = payload.snapshot ?? payload.caseSnapshot ?? payload.enrollment;
  const probation = record(payload.probation);
  const decisions = array(probation.decisions);
  const decision = payload.probationDecision ?? decisions[0] ?? null;
  const evidence = array(payload.evidence ?? payload.evidences ?? payload.assignmentEvidence);
  const reminders = array(payload.reminders);
  const assignments = array(payload.assignments ?? payload.currentAssignments);
  const checkIns = array(payload.checkIns ?? payload.checkins);
  return {
    caseId: typeof payload.caseId === 'number' ? payload.caseId : undefined,
    snapshot: snapshot ? {
      id: snapshot.id ?? snapshot.snapshotId,
      policyVersion: snapshot.policyVersion ?? snapshot.policy_version ?? null,
      plannedJoiningAt: snapshot.plannedJoiningAt ?? snapshot.planned_joining_at ?? snapshot.plannedJoiningDate ?? snapshot.joiningDate ?? null,
      actualJoinedAt: snapshot.actualJoinedAt ?? snapshot.actual_joined_at ?? null,
      probationLengthDays: snapshot.probationLengthDays ?? snapshot.probation_length_days ?? probation.lengthDays ?? null,
      anchorRevision: snapshot.anchorRevision ?? snapshot.anchor_revision ?? null,
      snapshotVersion: snapshot.snapshotVersion ?? snapshot.snapshot_version ?? null,
    } : null,
    assignments: assignments.map((assignment) => {
      const assignmentId = record(assignment).id ?? record(assignment).assignmentId;
      return normalizeAssignment(assignment, linkedRows(evidence, assignmentId, ['assignmentId', 'assignment_id']), reminders);
    }),
    checkIns: checkIns.map((checkIn) => {
      const checkInId = record(checkIn).id ?? record(checkIn).checkInId;
      return normalizeCheckIn(checkIn, linkedRows(evidence, checkInId, ['checkinId', 'checkin_id']), reminders);
    }),
    probationDecision: decision ? {
      disposition: decision.disposition ?? decision.outcome ?? null,
      decisionVersion: decision.decisionVersion ?? decision.decision_version ?? null,
       decidedAt: decision.decidedAt ?? decision.decided_at ?? decision.createdAt ?? decision.created_at ?? decision.effectiveAt ?? decision.effective_at ?? null,
       effectiveAt: decision.effectiveAt ?? decision.effective_at ?? null,
       extensionEndsAt: decision.extensionEndsAt ?? decision.extension_ends_at ?? null,
       anchorRevision: decision.anchorRevision ?? decision.anchor_revision ?? null,
       stale: decision.stale === true || decision.isStale === true || decision.staleAgainstCurrentAnchor === true || decision.stale_against_current_anchor === true,
      authority: decision.authority ?? decision.authorityScope ?? null,
    } : null,
    probation: {
      maturityAt: probation.maturityAt ?? probation.maturity_at ?? null,
      governedEndAt: probation.governedEndAt ?? probation.governed_end_at ?? null,
    },
  };
}

export async function getEarlyTenureCase(caseId: number): Promise<EarlyTenureCase> {
  const response = await customFetch<unknown>(`${EARLY_TENURE_ROOT}/cases/${caseId}`, { responseType: 'json' });
  return normalizeEarlyTenureCase(response);
}

export async function getEarlyTenureOwnerOptions(caseId: number): Promise<EarlyTenureOwnerOption[]> {
  const response = await customFetch<unknown>(`${EARLY_TENURE_ROOT}/cases/${caseId}/owner-options`, { responseType: 'json' });
  return array(response).map((value) => {
    const source = record(value);
    return { userId: String(source.userId ?? source.user_id ?? ''), role: String(source.role ?? 'member') };
  }).filter((value) => value.userId.length > 0);
}

export async function getEarlyTenureReminderInbox(caseType?: string,
  filters: { workforce?: string; safetyCritical?: boolean; siteExposure?: boolean } = {}): Promise<EarlyTenureInboxReminder[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ caseType, ...filters })) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const response = await customFetch<unknown>(`${EARLY_TENURE_ROOT}/reminders/inbox?${params}`, { responseType: 'json' });
  return array(response).map((value) => {
    const source = record(value);
    const targetType: EarlyTenureInboxReminder['targetType'] = source.targetType === 'checkin' ? 'checkin' : 'assignment';
    return {
      id: Number(source.id),
      targetType,
      dueAt: String(source.dueAt ?? source.due_at ?? ''),
      availableAt: String(source.availableAt ?? source.available_at ?? ''),
      label: typeof (source.label ?? source.obligationLabel) === 'string' ? source.label ?? source.obligationLabel : null,
      taskReference: typeof (source.taskReference ?? source.task_reference) === 'string' ? source.taskReference ?? source.task_reference : null,
      evidenceCompletionPath: typeof (source.evidenceCompletionPath ?? source.evidence_completion_path) === 'string' ? source.evidenceCompletionPath ?? source.evidence_completion_path : null,
    };
  }).filter((value) => Number.isInteger(value.id) && value.id > 0);
}

export function postEarlyTenure<T>(path: string, data?: unknown): Promise<T> {
  return customFetch<T>(`${EARLY_TENURE_ROOT}${path}`, {
    method: 'POST',
    responseType: 'json',
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

/** Completion paths are server-issued opaque actions from the member inbox.
 * Never derive a case or target URL from the inbox client. */
export function postEarlyTenureInboxEvidence<T>(path: string, data: { evidenceReference: string }): Promise<T> {
  if (!path.startsWith('/onboarding/early-tenure/')) {
    return Promise.reject(new Error('The reminder completion action is invalid. Reload your inbox.'));
  }
  return customFetch<T>(`/api${path}`, {
    method: 'POST',
    responseType: 'json',
    body: JSON.stringify({ ...data, observedAt: new Date().toISOString() }),
  });
}

/** Human-authorized restricted outcome evidence. Browser callers never select
 * trusted-provider provenance; the server binds the current case authority. */
export function postOutcomeEvidence<T>(path: '/surveys' | '/employment', data: unknown): Promise<T> {
  return customFetch<T>(`/api/onboarding/analytics/outcome-evidence${path}`, {
    method: 'POST',
    responseType: 'json',
    body: JSON.stringify(data),
  });
}

export function putEarlyTenure<T>(path: string, data: unknown): Promise<T> {
  return customFetch<T>(`${EARLY_TENURE_ROOT}${path}`, {
    method: 'PUT',
    responseType: 'json',
    body: JSON.stringify(data),
  });
}

export async function listEarlyTenurePolicies(): Promise<EarlyTenurePolicy[]> {
  const response = record(await customFetch<unknown>(`${EARLY_TENURE_ROOT}/policy`, { responseType: 'json' }));
  const values = response.policy && !Array.isArray(response.policy)
    ? [{ ...record(response.policy), version: response.version }]
    : array(response.policies ?? response.policyVersions ?? response.data ?? response);
  return values.map((entry) => {
    const policy = record(entry);
    return {
      id: policy.id ?? policy.policyId ?? 'unknown-policy',
      version: policy.version ?? null,
      status: policy.status ?? null,
      probationLengthDays: policy.probationLengthDays ?? policy.probation_length_days ?? null,
      checkInDays: array(policy.checkInDays ?? policy.check_in_days).map(Number).filter(Number.isFinite),
      decisionAuthorityScope: policy.decisionAuthorityScope ?? policy.decision_authority_scope ?? null,
      applicability: policy.applicability ?? null,
       obligations: array(policy.obligations) as EarlyTenurePolicyObligation[],
       checkIns: array(policy.checkIns) as EarlyTenurePolicyCheckIn[],
    };
  });
}