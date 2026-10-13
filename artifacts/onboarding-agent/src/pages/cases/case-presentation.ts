export const DEMO_FULL_COVERAGE_SCENARIO_PREFIX = 'UAT-DEMO-COVERAGE:';

export const CASE_TYPES = [
  'All Cases',
  'Onboarding',
  'Employee Changes',
  'Payroll',
  'Benefits',
  'Leave',
  'Compliance',
  'Offboarding',
  'HR Helpdesk',
  'IT Access',
  'Learning',
  'Mobility',
  'Documents',
] as const;

export type CaseTypeFilter = (typeof CASE_TYPES)[number];
export type CaseFamily = Exclude<CaseTypeFilter, 'All Cases'>;

type CaseLike = {
  caseFamily?: string | null;
  requestType?: string | null;
  scenarioKey?: string | null;
  hireType?: string | null;
};

/** Only the server's fictional identity projection is eligible for ordinary-list examples. */
export function isFictionalOfflineExample(c: { fictionalOfflineIdentity?: boolean; offlineSample?: boolean }) {
  return c.fictionalOfflineIdentity === true && c.offlineSample === true;
}

type SamplePresentationContext = { id: number; fictionalOfflineIdentity?: boolean; offlineSample?: boolean };

export function sampleCaseReference(c: SamplePresentationContext): string | null {
  return isFictionalOfflineExample(c) ? `S${c.id}` : null;
}

export function caseListReference(c: SamplePresentationContext & { createdAt?: string | null }): string {
  return sampleCaseReference(c) ?? `HRO-${c.createdAt ? new Date(c.createdAt).getFullYear() : new Date().getFullYear()}-${String(c.id).padStart(5, '0')}`;
}

export function caseWorkerName(c: SamplePresentationContext & { workerName: string }): string {
  return isFictionalOfflineExample(c) ? c.workerName.replace(/^Example — /, '') : c.workerName;
}

export function caseSummary(c: { fictionalOfflineIdentity?: boolean; offlineSample?: boolean; planSummary?: string | null }): string {
  const summary = c.planSummary ?? '';
  return isFictionalOfflineExample(c)
    ? summary.replace(/Offline example only; all evidence and human decisions remain pending\.$/, 'All evidence and human decisions remain pending.')
    : summary;
}

/** Transform only reserved placeholder fields, never arbitrary submitted prose. */
export function sampleIntakeFields(data: Record<string, string>, c?: SamplePresentationContext): [string, string][] {
  if (!c || !isFictionalOfflineExample(c)) return Object.entries(data);
  return Object.entries(data).flatMap(([key, value]): [string, string][] => {
    if (key === 'request_id' && /^(UAT-DEMO-|FICTIONAL-)/.test(value)) return [];
    if (key === 'worker_name') return [[key, caseWorkerName({ ...c, workerName: value })]];
    if ((key.endsWith('_reference') || key === 'employee_id' || key === 'previous_employee_id')
      && /^FICTIONAL-[A-Z0-9-]+(?: \/ FICTIONAL-[A-Z0-9-]+)*$/.test(value)) {
      if (value === 'FICTIONAL-REF-A / FICTIONAL-REF-B') return [[key, 'Conflicting references A and B — neither verified']];
      return [];
    }
    return [[key, value]];
  });
}

export function casesForList<T extends { controllerRetired?: boolean; fictionalOfflineIdentity?: boolean; offlineSample?: boolean }>(rows: readonly T[], historyOnly: boolean): T[] {
  return rows.filter(row => historyOnly ? row.controllerRetired : !row.controllerRetired || isFictionalOfflineExample(row));
}

const SERVICE_CASE_PRESENTATION: Record<string, { type: CaseFamily; title: string; owner: string }> = {
  'standard-fte': { type: 'Onboarding', title: 'Standard external FTE', owner: 'Onboarding Coordinator' },
  'internal-transfer': { type: 'Employee Changes', title: 'Internal transfer / role change', owner: 'Worker Records Specialist' },
  'payroll-bank-change': { type: 'Payroll', title: 'Payroll bank-detail change', owner: 'Payroll Specialist' },
  'benefits-life-event': { type: 'Benefits', title: 'Benefits life-event enrolment', owner: 'Benefits Specialist' },
  'leave-parental': { type: 'Leave', title: 'Parental leave request', owner: 'Leave Specialist' },
  'compliance-work-authorization': { type: 'Compliance', title: 'Work authorization renewal', owner: 'Compliance Specialist' },
  'offboarding-voluntary': { type: 'Offboarding', title: 'Voluntary offboarding', owner: 'Offboarding Coordinator' },
  'helpdesk-employment-letter': { type: 'HR Helpdesk', title: 'Employment confirmation letter', owner: 'HR Service Agent' },
  'it-privileged-access': { type: 'IT Access', title: 'Privileged application access', owner: 'Identity & Access Specialist' },
  'learning-mandatory-certification': { type: 'Learning', title: 'Mandatory certification assignment', owner: 'Learning Specialist' },
  'mobility-country-transfer': { type: 'Mobility', title: 'Cross-border employee transfer', owner: 'Mobility Specialist' },
  'documents-policy-acknowledgement': { type: 'Documents', title: 'Policy acknowledgement', owner: 'Worker Records Specialist' },
};

export function originalCoverageScenarioKey(scenarioKey: string | null | undefined) {
  return scenarioKey?.startsWith(DEMO_FULL_COVERAGE_SCENARIO_PREFIX)
    ? scenarioKey.slice(DEMO_FULL_COVERAGE_SCENARIO_PREFIX.length)
    : scenarioKey ?? null;
}

export function isDemoCoverageCase(c: Pick<CaseLike, 'scenarioKey'>) {
  return c.scenarioKey?.startsWith(DEMO_FULL_COVERAGE_SCENARIO_PREFIX) === true;
}

export function casePresentationOf(c: CaseLike) {
  if (c.caseFamily && CASE_TYPES.includes(c.caseFamily as CaseTypeFilter) && c.caseFamily !== 'All Cases') {
    const reference = Object.values(SERVICE_CASE_PRESENTATION).find(item => item.type === c.caseFamily)!;
    return { ...reference, title: c.requestType || reference.title };
  }
  const scenarioKey = originalCoverageScenarioKey(c.scenarioKey);
  return scenarioKey ? SERVICE_CASE_PRESENTATION[scenarioKey] : undefined;
}

export function caseTypeOf(c: CaseLike): CaseFamily {
  if (c.caseFamily && CASE_TYPES.includes(c.caseFamily as CaseTypeFilter) && c.caseFamily !== "All Cases") return c.caseFamily as CaseFamily;
  return casePresentationOf(c)?.type ??
    (c.hireType === 'internal-transfer' ? 'Employee Changes' : 'Onboarding');
}

export function caseTitleOf(c: CaseLike): string {
  if (c.requestType) return c.requestType;
  const presentation = casePresentationOf(c);
  if (presentation) return presentation.title;
  switch (c.hireType) {
    case 'contractor': return 'Contractor Onboarding';
    case 'rehire': return 'Rehire Onboarding';
    case 'internal-transfer': return 'Employee Transfer';
    default: return 'New Hire Onboarding';
  }
}