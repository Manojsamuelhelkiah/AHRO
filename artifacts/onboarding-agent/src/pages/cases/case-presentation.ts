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

/** Consume only the authorized server projection; never infer missing history. */
export function originalIntentOf(c: { originalIntent?: string | null }): string {
  return c.originalIntent === null ? 'Restricted' : c.originalIntent || 'Not recorded';
}

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
  return isFictionalOfflineExample(c) ? c.workerName.replace(/^(?:Example|Demo sample) — /, '') : c.workerName;
}

export function caseSummary(c: { fictionalOfflineIdentity?: boolean; offlineSample?: boolean; planSummary?: string | null; syntheticJourney?: { qualifier: string; rationale: string } | null }): string {
  if (c.syntheticJourney) return `${c.syntheticJourney.qualifier} · ${c.syntheticJourney.rationale}`;
  const summary = c.planSummary ?? '';
  return isFictionalOfflineExample(c)
    ? summary.replace(/Offline example only; all evidence and human decisions remain pending\.$/, 'All evidence and human decisions remain pending.')
    : summary;
}

/** Transform only reserved placeholder fields, never arbitrary submitted prose. */
export function sampleIntakeFields(data: Record<string, string>, c?: SamplePresentationContext): [string, string][] {
  if (!c || !isFictionalOfflineExample(c)) return Object.entries(data);
  return Object.entries(data).flatMap(([key, value]): [string, string][] => {
    if (/(?:^|_)(?:date|due_at)$/.test(key) && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
      return [[key, 'Not confirmed']];
    }
    if (key === 'request_id' && /^(UAT-DEMO-|FICTIONAL-)/.test(value)) return [];
    if (key === 'worker_name') return [[key, caseWorkerName({ ...c, workerName: value })]];
    if ((key.endsWith('_reference') || key === 'employee_id' || key === 'previous_employee_id')
      && /^FICTIONAL-[A-Z0-9-]+(?: \/ FICTIONAL-[A-Z0-9-]+)*$/.test(value)) {
      if (value === 'FICTIONAL-REF-A / FICTIONAL-REF-B') return [[key, 'Conflicting references A and B — neither verified']];
      return [];
    }
    // The sample request is the server's exact fixed inventory projection.
    // Never transform arbitrary operational intake when the marker is absent.
    return [[key, value.replace(/\bFictional\s+/g, '')]];
  });
}

/** Fixed inventory dates are not independently confirmed operating dates. */
export function confirmedCaseDate(c: {
  joiningDate?: string; fictionalOfflineIdentity?: boolean; offlineSample?: boolean;
  operationalActivated?: boolean;
}): string | null {
  if (isFictionalOfflineExample(c) && !c.operationalActivated) return null;
  return c.joiningDate && Number.isFinite(Date.parse(c.joiningDate)) ? c.joiningDate : null;
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
    (c.hireType === 'offboarding' || c.hireType === 'separation' ? 'Offboarding' : c.hireType === 'internal-transfer' ? 'Employee Changes' : 'Onboarding');
}

const AGENT_BY_FAMILY: Record<CaseFamily, string> = {
  Onboarding: 'Onboarding Agent', Offboarding: 'Offboarding Agent',
  'Employee Changes': 'Employee Changes Agent', Payroll: 'Payroll Agent',
  Benefits: 'Benefits Agent', Leave: 'Leave Agent', Compliance: 'Compliance Agent',
  'HR Helpdesk': 'HR Helpdesk Agent', 'IT Access': 'IT Access Agent',
  Learning: 'Learning Agent', Mobility: 'Mobility Agent', Documents: 'Documents & Records Agent',
};

/** Presentation only: retain recorded ownership, state and specific blockers. */
export function workstreamPresentation(c: CaseLike & { fictionalOfflineIdentity?: boolean; offlineSample?: boolean }, w: { agent?: string; owner?: string; label?: string; key?: string; blockers?: string[] }) {
  const rawAgent = w.agent?.trim();
  const agent = !rawAgent || rawAgent.toLowerCase() === 'none'
    ? AGENT_BY_FAMILY[caseTypeOf(c)]
    : ({ documentation: 'Document Verification Agent', access: 'IT Access Agent',
      assets: 'Assets & Workplace Agent', learning: 'Learning Agent', analytics: 'Coordination agent not mapped — review required',
      'Worker Records Agent': AGENT_BY_FAMILY[caseTypeOf(c)],
      'Identity & Access Agent': 'IT Access Agent', 'HR Service Agent': 'HR Helpdesk Agent' } as Record<string, string>)[rawAgent] || rawAgent;
  const owner = !w.owner?.trim() || w.owner === 'Unassigned — offline example'
    ? 'No recorded owner — human assignment required' : w.owner;
  const blockers = (w.blockers || []).map(blocker => isFictionalOfflineExample(c) &&
    ['Offline demo sample', 'Offline example; no execution permitted'].includes(blocker)
    ? 'Operational activation, current evidence and applicable human decisions are required.' : blocker);
  return { agent, owner, label: w.label || 'Unnamed workstream', blockers };
}

/** Status alone never establishes a human handoff. */
export function caseOwnerOf(c: CaseLike & { currentActionOwner?: string | null }) {
  const coordinatingAgent = AGENT_BY_FAMILY[caseTypeOf(c)];
  return { name: c.currentActionOwner || coordinatingAgent,
    kind: c.currentActionOwner ? 'Human Reviewer' as const : 'AI Agent' as const, coordinatingAgent };
}

export function caseTitleOf(c: CaseLike): string {
  if (c.requestType) return c.requestType;
  const presentation = casePresentationOf(c);
  if (presentation) return presentation.title;
  switch (c.hireType) {
    case 'separation':
    case 'offboarding': return 'Offboarding';
    case 'contractor': return 'Contractor Onboarding';
    case 'rehire': return 'Rehire Onboarding';
    case 'internal-transfer': return 'Employee Transfer';
    default: return 'New Hire Onboarding';
  }
}
