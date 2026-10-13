import { customFetch } from '@workspace/api-client-react';

export type WorkforceContext = {
  roleFamily?: string;
  band?: string;
  department?: string;
  legalEntity?: string;
  workCountry?: string;
  site?: string;
  payBasis?: string;
  shiftPattern?: string;
  workEnvironment?: 'office' | 'remote' | 'site' | 'field' | 'mixed';
  hazards?: string[];
  requiredLicenses?: string[];
  hiringMode?: 'individual' | 'batch' | 'seasonal';
  assistedIntake?: boolean;
  siteExposure?: boolean;
  safetyCritical?: boolean;
};

/**
 * Applies a context-editor value without turning an explicit `false` fact into
 * "unknown". Empty text remains unknown so it is not sent as a criterion.
 */
export function updateWorkforceContext<T extends object>(
  context: T,
  key: keyof T,
  value: string | boolean | string[] | undefined,
): T {
  const trimmedList = Array.isArray(value)
    ? value.map((item) => item.trim()).filter(Boolean)
    : undefined;
  const normalized = typeof value === 'string'
    ? value.trim() || undefined
    : trimmedList
      ? trimmedList.length ? trimmedList : undefined
      : value;
  return { ...context, [key]: normalized } as T;
}

export function hasExplicitWorkforceContext(context: WorkforceContext): boolean {
  return Object.values(context).some((value) =>
    value !== undefined
    && value !== ''
    && (!Array.isArray(value) || value.length > 0),
  );
}

/** Converts an explicit context select value to a fact, retaining "unknown". */
export function parseWorkforceTriState(value: FormDataEntryValue | null): boolean | undefined {
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return undefined;
}

export type JobProfile = {
  organizationId: string;
  profileId: string;
  version: number;
  name: string;
  context: WorkforceContext;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
};

export type JobProfileInput = {
  profileId?: string;
  expectedVersion?: number;
  name: string;
  context: WorkforceContext;
  enabled: boolean;
};

export type WorkforceStarterTemplate = {
  key: 'office-lateral' | 'frontline-site' | 'mixed-work';
  name: string;
  reviewed: 'expert-authored-starter';
  description: string;
  criteria: Record<string, string>;
  overrides: Array<Record<string, unknown>>;
  processPolicy: Record<string, unknown>;
};

export function listWorkforceStarterTemplates(options?: RequestInit) {
  return customFetch<WorkforceStarterTemplate[]>('/api/onboarding/workforce-policy-templates', { ...options, method: 'GET', responseType: 'json' });
}

export function listJobProfiles(options?: RequestInit) {
  return customFetch<JobProfile[]>('/api/onboarding/job-profiles', { ...options, method: 'GET', responseType: 'json' });
}

export function saveJobProfile(data: JobProfileInput, options?: RequestInit) {
  return customFetch<JobProfile>('/api/onboarding/job-profiles', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    body: JSON.stringify(data),
    responseType: 'json',
  });
}

export type BatchIntakePerson = {
  /** Personal intake fields never grant workflow approval permissions. */
  personKey: string;
  workerName: string;
  workerEmail: string;
  workerPhone?: string;
  channelPreference?: 'email' | 'whatsapp' | 'both';
  hireType: string;
  workerCategory: string;
  workerBand?: string;
  role: string;
  department: string;
  geography: string;
  legalEntity: string;
  managerName: string;
  recruiterName: string;
  joiningDate: string;
  urgency?: string;
  notes?: string;
  jobProfileId?: string;
  workforceContext?: WorkforceContext;
};

export type TenantMember = { userId: string; role: 'owner' | 'admin' | 'member' };
export function listTenantMembers(options?: RequestInit) {
  return customFetch<TenantMember[]>('/api/onboarding/members', { ...options, method: 'GET', responseType: 'json' });
}
/** Routing context for confirmed office/remote work with no site exposure; not an access grant. */
export const ORGANIZATION_REVIEW_CONTEXT = '__organization__';

export type BatchIntakeResult = {
  batchId: string;
  name: string;
  retry: boolean;
  results: Array<{ personKey: string; caseId: number; status: 'created' | 'reconciled'; profileId: string; profileVersion: number }>;
};

export function submitBatchIntake(data: { idempotencyKey: string; name: string; people: BatchIntakePerson[] }, options?: RequestInit) {
  return customFetch<BatchIntakeResult>('/api/onboarding/batch-intake', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    body: JSON.stringify(data),
    responseType: 'json',
  });
}

export function releaseBatchIntakeCase(batchId: string, caseId: number, options?: RequestInit) {
  return customFetch<{ caseId: number; batchId: string; orchestrationStatus: string }>(
    `/api/onboarding/batch-intake/${encodeURIComponent(batchId)}/cases/${caseId}/release`,
    { ...options, method: 'POST', responseType: 'json' },
  );
}