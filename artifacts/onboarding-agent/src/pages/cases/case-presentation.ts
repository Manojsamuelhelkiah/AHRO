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
  scenarioKey?: string | null;
  hireType?: string | null;
};

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
  const scenarioKey = originalCoverageScenarioKey(c.scenarioKey);
  return scenarioKey ? SERVICE_CASE_PRESENTATION[scenarioKey] : undefined;
}

export function caseTypeOf(c: CaseLike): CaseFamily {
  return casePresentationOf(c)?.type ??
    (c.hireType === 'internal-transfer' ? 'Employee Changes' : 'Onboarding');
}

export function caseTitleOf(c: CaseLike): string {
  const presentation = casePresentationOf(c);
  if (presentation) return presentation.title;
  switch (c.hireType) {
    case 'contractor': return 'Contractor Onboarding';
    case 'rehire': return 'Rehire Onboarding';
    case 'internal-transfer': return 'Employee Transfer';
    default: return 'New Hire Onboarding';
  }
}