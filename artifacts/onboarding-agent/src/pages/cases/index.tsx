import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  useListOnboardingCases,
  useCreateOnboardingCase,
  useGetCurrentOrganization,
  getListOnboardingCasesQueryKey,
  customFetch,
  getPinnedOrganizationIdForPage,
} from '@workspace/api-client-react';
import type { OnbCase as ApiOnbCase } from '@workspace/api-client-react';
import { Link, useLocation, useSearch } from 'wouter';
import { Card, Button, Input, cn, Label, PageHeader } from '@/components/ui-shared';
import { format } from 'date-fns';
import { Plus, Search, SlidersHorizontal, Bot, User, Users, X, FlaskConical, Check, AlertTriangle, Clock, Presentation, ShieldCheck } from 'lucide-react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { BatchIntakeForm } from './batch-intake';
import { StandardIntakeForm } from './standard-intake';
import { listJobProfiles, parseWorkforceTriState } from '@/lib/workforce-policy-api';
import {
  CASE_TYPES,
  caseTitleOf as presentedCaseTitleOf,
  caseTypeOf as presentedCaseTypeOf,
  isDemoCoverageCase,
  originalCoverageScenarioKey,
  type CaseTypeFilter,
} from './case-presentation';

type OnbCase = ApiOnbCase;

/* ------------------------- HRO case model mapping ------------------------- */
/* Existing records are onboarding cases; map them into the neutral HRO case
   shape so additional case types can be introduced incrementally. */

type HroStatus = 'New' | 'In Progress' | 'Waiting' | 'Human Review' | 'Blocked' | 'Completed';

export function caseTypeOf(c: OnbCase): Exclude<CaseTypeFilter, 'All Cases'> {
  return presentedCaseTypeOf(c);
}

export function caseTitleOf(c: OnbCase): string {
  return presentedCaseTitleOf(c);
}

function caseIdOf(c: OnbCase): string {
  const year = c.createdAt ? new Date(c.createdAt).getFullYear() : new Date().getFullYear();
  return `HRO-${year}-${String(c.id).padStart(5, '0')}`;
}

export function statusOf(c: Pick<OnbCase, 'lifecycleStage' | 'orchestrationStatus'>): HroStatus {
  const stage = (c.lifecycleStage || '').toLowerCase();
  const orch = (c.orchestrationStatus || '').toLowerCase();
  if (stage === 'completed' || stage === 'complete') return 'Completed';
  if (orch === 'blocked' || orch === 'checklist-blocked' || orch === 'failed' || stage === 'exception') return 'Blocked';
  if (orch === 'waiting-approval') return 'Human Review';
  if (stage === 'trigger-received') return 'New';
  if (orch === 'running') return 'In Progress';
  return 'Waiting';
}

function ownerOf(c: OnbCase): { name: string; kind: 'AI Agent' | 'Human Reviewer' } {
  if (statusOf(c) === 'Human Review') return { name: 'HR Reviewer', kind: 'Human Reviewer' };
  const specialistByType: Record<Exclude<CaseTypeFilter, 'All Cases'>, string> = {
    Onboarding: 'Onboarding Coordinator',
    'Employee Changes': 'Worker Records Specialist',
    Payroll: 'Payroll Specialist',
    Benefits: 'Benefits Specialist',
    Leave: 'Leave Specialist',
    Compliance: 'Compliance Specialist',
    Offboarding: 'Offboarding Coordinator',
    'HR Helpdesk': 'HR Service Agent',
    'IT Access': 'Identity & Access Specialist',
    Learning: 'Learning Specialist',
    Mobility: 'Mobility Specialist',
    Documents: 'Worker Records Specialist',
  };
  return { name: specialistByType[caseTypeOf(c)], kind: 'AI Agent' };
}

const PAGE_CONTEXT: Record<CaseTypeFilter, { title: string; subtitle: string }> = {
  'All Cases': { title: 'HR Operations Cases', subtitle: 'Manage and track HR operations across the employee lifecycle.' },
  'Onboarding': { title: 'Onboarding Cases', subtitle: 'Manage and track employee onboarding cases.' },
  'Employee Changes': { title: 'Employee Change Cases', subtitle: 'Transfers, promotions, and role or location changes.' },
  'Payroll': { title: 'Payroll Cases', subtitle: 'Payroll setup, corrections, and missing payments.' },
  'Benefits': { title: 'Benefits Cases', subtitle: 'Enrollment, eligibility, and life events.' },
  'Leave': { title: 'Leave Cases', subtitle: 'Leave requests and return-to-work processes.' },
  'Compliance': { title: 'Compliance Cases', subtitle: 'Work authorization, document expiry, and policy exceptions.' },
  'Offboarding': { title: 'Offboarding Cases', subtitle: 'Resignations, terminations, and access removal.' },
  'HR Helpdesk': { title: 'HR Helpdesk Cases', subtitle: 'Employee inquiries, document requests, and policy questions.' },
  'IT Access': { title: 'IT Access Cases', subtitle: 'Identity, application access, and privileged-role requests.' },
  'Learning': { title: 'Learning Cases', subtitle: 'Curriculum assignment, certification, and induction tracking.' },
  'Mobility': { title: 'Mobility Cases', subtitle: 'Cross-border moves, relocation, tax, and immigration coordination.' },
  'Documents': { title: 'Document Cases', subtitle: 'Letters, policy acknowledgements, and worker-record documents.' },
};

const SYNTHETIC_SCENARIO_KEYS = [
  'standard-fte',
  'internal-transfer',
  'payroll-bank-change',
  'benefits-life-event',
  'leave-parental',
  'compliance-work-authorization',
  'offboarding-voluntary',
  'helpdesk-employment-letter',
  'it-privileged-access',
  'learning-mandatory-certification',
  'mobility-country-transfer',
  'documents-policy-acknowledgement',
] as const;

/* ------------------------------ status badge ------------------------------ */

const STATUS_STYLES: Record<HroStatus, { bg: string; fg: string; dot?: boolean }> = {
  'New': { bg: 'var(--primary-light)', fg: 'var(--primary-dark)' },
  'In Progress': { bg: 'var(--primary-light)', fg: 'var(--primary)', dot: true },
  'Waiting': { bg: 'var(--surface-alt)', fg: 'var(--text-muted)' },
  'Human Review': { bg: 'var(--surface-soft)', fg: 'var(--status-amber)' },
  'Blocked': { bg: 'var(--surface-soft)', fg: 'var(--status-red)' },
  'Completed': { bg: 'var(--surface-soft)', fg: 'var(--status-green)' },
};

function HroStatusBadge({ status }: { status: HroStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span style={{ backgroundColor: s.bg, color: s.fg, fontSize: 'var(--text-xs)', fontWeight: 600, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
      {s.dot && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--primary)' }} />}
      {status}
    </span>
  );
}

function CaseTypeBadge({ type }: { type: string }) {
  return (
    <span style={{ backgroundColor: 'var(--surface-alt)', color: 'var(--text-secondary)', border: '1px solid var(--border)', fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
      {type === 'Employee Changes' ? 'Employee Change' : type}
    </span>
  );
}

function CompactGates({ gateways }: { gateways?: { a?: any; b?: any; c?: any } }) {
  if (!gateways) return null;
  const gates = [
    { key: 'A', g: gateways.a },
    { key: 'B', g: gateways.b },
    { key: 'C', g: gateways.c },
  ];
  return (
    <div className="flex items-center gap-1">
      {gates.map(({ key, g }) => {
        if (!g) return null;
        let bg = 'var(--surface-alt)';
        let fg = 'var(--text-muted)';
        let Icon = null;
        if (g.status === 'complete') { bg = 'var(--status-green-bg)'; fg = 'var(--status-green-fg)'; Icon = Check; }
        else if (g.status === 'blocked') { bg = 'var(--status-red-bg)'; fg = 'var(--status-red-fg)'; Icon = AlertTriangle; }
        else if (g.status === 'human-review') { bg = 'var(--status-amber-bg)'; fg = 'var(--status-amber-fg)'; Icon = Clock; }
        else if (g.status === 'pending') { bg = 'var(--primary-light)'; fg = 'var(--primary)'; Icon = Clock; }
        return (
          <div key={key} title={`${key}: ${g.label} - ${g.status}`} className="flex items-center justify-center rounded-sm relative" style={{ width: '22px', height: '22px', backgroundColor: bg, color: fg, border: '1px solid var(--border)' }}>
            <span className="sr-only">Gateway {key}: {g.label} - {g.status}</span>
            <span className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--surface)]" style={{ padding: '1px', border: '1px solid var(--border)' }}>
              {Icon && <Icon className="w-2 h-2" style={{ color: fg }} />}
            </span>
            <span className="font-mono" style={{ fontSize: '10px', fontWeight: 700 }}>{key}</span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------- filters -------------------------------- */

type AdvancedFilters = {
  status: '' | HroStatus;
  agent: '' | 'AI Agent' | 'Human Reviewer';
  priority: '' | 'normal' | 'standard' | 'high' | 'elevated' | 'critical';
  geography: string;
  dateFrom: string;
  dateTo: string;
  workforce: '' | 'white-collar' | 'blue-collar-frontline' | 'mixed' | 'needs-review' | 'unclassified';
  siteExposure: '' | 'yes' | 'no';
  safetyCritical: '' | 'yes' | 'no';
};

const EMPTY_FILTERS: AdvancedFilters = { status: '', agent: '', priority: '', geography: '', dateFrom: '', dateTo: '', workforce: '', siteExposure: '', safetyCritical: '' };

function workforceLabel(c: OnbCase) {
  return c.workforceClassification?.label ?? 'unclassified';
}
function WorkforceTags({ c }: { c: OnbCase }) {
  const context = c.workforceContext ?? {};
  return <div className="mt-1 flex flex-wrap gap-1">
    <span className="rounded bg-[var(--surface-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">{workforceLabel(c).replace(/-/g, ' ')}</span>
    {context.siteExposure === true && <span className="rounded bg-[var(--status-amber-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--status-amber-fg)]">Site exposure</span>}
    {context.siteExposure === false && <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">No site exposure</span>}
    {context.safetyCritical === true && <span className="rounded bg-[var(--status-red-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--status-red-fg)]">Safety-critical</span>}
    {context.safetyCritical === false && <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">Not safety-critical</span>}
  </div>;
}

function intakeClassification(context: { workEnvironment?: string; siteExposure?: string; safetyCritical?: string; hazards?: string }) {
  const safetyKnown = (context.siteExposure === 'yes' || context.siteExposure === 'no') && (context.safetyCritical === 'yes' || context.safetyCritical === 'no');
  const frontline = context.workEnvironment === 'site' || context.workEnvironment === 'field' || context.siteExposure === 'yes' || context.safetyCritical === 'yes' || Boolean(context.hazards?.trim());
  const office = (context.workEnvironment === 'office' || context.workEnvironment === 'remote') && safetyKnown;
  const label = office && frontline ? 'mixed' : frontline ? 'blue-collar-frontline' : office ? 'white-collar' : 'needs-review';
  return {
    label,
    rationale: label === 'needs-review'
      ? 'Work environment and safety applicability are incomplete, so a human context review gate will be added.'
      : `Derived only from explicit ${[context.workEnvironment && `environment ${context.workEnvironment}`, context.siteExposure === 'yes' && 'site exposure', context.safetyCritical === 'yes' && 'safety-critical duties', context.hazards?.trim() && 'recorded hazards'].filter(Boolean).join(', ')}.`,
    uncertainty: label === 'needs-review' ? 'Uncertain — the system does not infer safety facts.' : 'High confidence from supplied job facts.',
  };
}

export function CasesPage() {
  const search = useSearch();
  const checklistProfileId = new URLSearchParams(search).get('checklistProfileId');
  const { data: cases, isLoading, isError, refetch } = useListOnboardingCases({
    query: {
      queryKey: getListOnboardingCasesQueryKey(),
      refetchInterval: (query: any) => {
        const active = query?.state?.data?.some((c: any) => c.orchestrationStatus !== 'completed' && c.orchestrationStatus !== 'done');
        return active ? 5000 : false;
      }
    }
  });
  const [showNew, setShowNew] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [showStandardIntake, setShowStandardIntake] = useState(false);
  const [, setLocation] = useLocation();
  const [typeFilter, setTypeFilter] = useState<CaseTypeFilter>('All Cases');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<AdvancedFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const isDevelopmentDemo = getPinnedOrganizationIdForPage() === 'demo';

  useEffect(() => {
    if (!showFilters) return;
    const onClick = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setShowFilters(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFilters(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [showFilters]);

  const geographies = useMemo(
    () => Array.from(new Set((cases ?? []).map((c) => c.geography).filter(Boolean))).sort(),
    [cases],
  );

  const filtered = useMemo(() => {
    let rows = cases ?? [];
    if (checklistProfileId) rows = rows.filter((c) => c.checklistProfileId === checklistProfileId);
    if (typeFilter !== 'All Cases') rows = rows.filter((c) => caseTypeOf(c) === typeFilter);
    if (filters.status) rows = rows.filter((c) => statusOf(c) === filters.status);
    if (filters.agent) rows = rows.filter((c) => ownerOf(c).kind === filters.agent);
    if (filters.priority) rows = rows.filter((c) => (c.urgency || '').toLowerCase() === filters.priority);
    if (filters.geography) rows = rows.filter((c) => c.geography === filters.geography);
    if (filters.dateFrom) rows = rows.filter((c) => c.joiningDate >= filters.dateFrom);
    if (filters.dateTo) rows = rows.filter((c) => c.joiningDate <= filters.dateTo);
    if (filters.workforce) rows = rows.filter((c) => workforceLabel(c) === filters.workforce);
    if (filters.siteExposure) rows = rows.filter((c) => c.workforceContext?.siteExposure === (filters.siteExposure === 'yes'));
    if (filters.safetyCritical) rows = rows.filter((c) => c.workforceContext?.safetyCritical === (filters.safetyCritical === 'yes'));
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((c) =>
        [c.workerName, c.workerEmail, caseTitleOf(c), caseIdOf(c), String(c.id), c.role, c.geography]
          .some((v) => (v || '').toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [cases, checklistProfileId, typeFilter, filters, query]);

  const counts = useMemo(() => {
    const rows = cases ?? [];
    const by = (s: HroStatus) => rows.filter((c) => statusOf(c) === s).length;
    return {
      all: rows.length,
      inProgress: by('In Progress'),
      humanReview: by('Human Review'),
      waiting: by('Waiting'),
      blocked: by('Blocked'),
      completed: by('Completed'),
    };
  }, [cases]);
  const caseTypeCounts = useMemo(() => {
    const rows = cases ?? [];
    return Object.fromEntries(CASE_TYPES.map((type) => [
      type,
      type === 'All Cases' ? rows.length : rows.filter((c) => caseTypeOf(c) === type).length,
    ])) as Record<CaseTypeFilter, number>;
  }, [cases]);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const anyFilterActive = activeFilterCount > 0 || query.trim() !== '' || typeFilter !== 'All Cases' || Boolean(checklistProfileId);
  const context = PAGE_CONTEXT[typeFilter];

  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setQuery('');
    setTypeFilter('All Cases');
    if (checklistProfileId) setLocation('/cases');
  };

  const selectStyle = 'flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]';
  const existingSyntheticKeys = new Set(
    (cases ?? [])
      .filter(isDemoCoverageCase)
      .map((c) => originalCoverageScenarioKey(c.scenarioKey))
      .filter((key): key is string => Boolean(key)),
  );
  const missingSyntheticKeys = SYNTHETIC_SCENARIO_KEYS.filter((key) => !existingSyntheticKeys.has(key));

  const seedSyntheticCoverage = async () => {
    if (!isDevelopmentDemo || missingSyntheticKeys.length === 0) return;
    setIsSeeding(true);
    setSeedError(null);
    try {
      await customFetch<{
        createdCaseIds: number[];
        existingCaseIds: number[];
        scenarioKeys: string[];
        offline: boolean;
      }>('/api/onboarding/demo/full-coverage', {
        method: 'POST',
        body: JSON.stringify({}),
        responseType: 'json',
      });
      await refetch();
    } catch (error: any) {
      setSeedError(error?.response?.data?.message || error?.message || 'The synthetic coverage set could not be created.');
    } finally {
      setIsSeeding(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader title={context.title} subtitle={context.subtitle}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={seedSyntheticCoverage}
            disabled={!isDevelopmentDemo || isLoading || isSeeding || missingSyntheticKeys.length === 0}
            className="gap-2"
            title={!isDevelopmentDemo
              ? 'Sample coverage is restricted to the Development Demo organization; this workspace will not be seeded.'
              : missingSyntheticKeys.length === 0
                ? 'Offline demo coverage is already present'
                : `Create ${missingSyntheticKeys.length} missing offline Demo cases`}
          >
            <FlaskConical className="h-4 w-4" />
            {isSeeding ? 'Adding Demo samples…' : !isDevelopmentDemo ? 'Demo samples only' : missingSyntheticKeys.length === 0 ? 'Demo set ready' : `Add Demo set (${missingSyntheticKeys.length})`}
          </Button>
          <Link href="/demo-controller" className="inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-soft)] h-9 px-4 py-2 gap-2">
            <Presentation className="h-4 w-4" /> Demo Center
          </Link>
          <Button onClick={() => setShowNew(!showNew)} className="gap-2">
            <Plus className="h-4 w-4" /> New Case
          </Button>
          <Button variant="outline" onClick={() => setShowBatch(!showBatch)} className="gap-2">
            <Users className="h-4 w-4" /> Batch Intake
          </Button>
           <Button variant="outline" onClick={() => setShowStandardIntake(!showStandardIntake)} className="gap-2">
             <ShieldCheck className="h-4 w-4" /> Trusted Intake
           </Button>
        </div>
      </PageHeader>

      {seedError && (
        <div role="alert" className="rounded-[var(--radius-md)] border px-4 py-3 text-sm" style={{ borderColor: 'var(--status-red)', backgroundColor: 'var(--status-red-bg)', color: 'var(--status-red-fg)' }}>
          {seedError}
        </div>
      )}

      {showNew && <NewCaseForm onClose={() => setShowNew(false)} />}
       {showBatch && <BatchIntakeForm onClose={() => setShowBatch(false)} />}
       {showStandardIntake && <StandardIntakeForm onClose={() => setShowStandardIntake(false)} />}

      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'visible' }}>
        {/* search + filters row */}
        <div style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)' }} className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            <Input className="pl-9" placeholder="Search by case, worker, email, or ID..." value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="relative" ref={filtersRef}>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} aria-haspopup="dialog" aria-controls="cases-filters-panel">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {activeFilterCount > 0 && (
                <span style={{ backgroundColor: 'var(--primary)', color: '#fff', borderRadius: '999px', fontSize: '10px', fontWeight: 700, padding: '1px 6px', lineHeight: '14px' }}>{activeFilterCount}</span>
              )}
            </Button>
            {showFilters && (
              <div id="cases-filters-panel" role="dialog" aria-label="Case filters" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: '300px', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md, 0 8px 24px rgba(16,24,40,0.12))', padding: 'var(--space-lg)', zIndex: 30 }} className="space-y-3">
                <div className="flex items-center justify-between">
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Filters</span>
                  <button onClick={() => setShowFilters(false)} style={{ color: 'var(--text-muted)' }} aria-label="Close filters"><X className="h-4 w-4" /></button>
                </div>
                <div className="space-y-1">
                  <Label>Case Type</Label>
                  <select className={selectStyle} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as CaseTypeFilter)}>
                    {CASE_TYPES.map((t) => <option key={t} value={t}>{t} ({caseTypeCounts[t]})</option>)}
                  </select>
                </div>
                 <div className="space-y-1"><Label>Workforce classification</Label><select className={selectStyle} value={filters.workforce} onChange={(e) => setFilters({ ...filters, workforce: e.target.value as AdvancedFilters['workforce'] })}><option value="">Any classification</option><option value="white-collar">White-collar</option><option value="blue-collar-frontline">Frontline / site</option><option value="mixed">Mixed</option><option value="needs-review">Needs review</option><option value="unclassified">Unclassified</option></select></div>
                 <div className="grid grid-cols-2 gap-2"><div className="space-y-1"><Label>Site exposure</Label><select className={selectStyle} value={filters.siteExposure} onChange={(e) => setFilters({ ...filters, siteExposure: e.target.value as AdvancedFilters['siteExposure'] })}><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option></select></div><div className="space-y-1"><Label>Safety-critical</Label><select className={selectStyle} value={filters.safetyCritical} onChange={(e) => setFilters({ ...filters, safetyCritical: e.target.value as AdvancedFilters['safetyCritical'] })}><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option></select></div></div>
                <div className="space-y-1">
                  <Label>Status</Label>
                  <select className={selectStyle} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as AdvancedFilters['status'] })}>
                    <option value="">Any status</option>
                    {(['New', 'In Progress', 'Waiting', 'Human Review', 'Blocked', 'Completed'] as HroStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Assigned Agent</Label>
                  <select className={selectStyle} value={filters.agent} onChange={(e) => setFilters({ ...filters, agent: e.target.value as AdvancedFilters['agent'] })}>
                    <option value="">Any owner</option>
                    <option value="AI Agent">AI Agent</option>
                    <option value="Human Reviewer">Human Reviewer</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Priority</Label>
                  <select className={selectStyle} value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value as AdvancedFilters['priority'] })}>
                    <option value="">Any priority</option>
                    <option value="standard">Standard</option>
                    <option value="normal">Normal</option>
                    <option value="elevated">Elevated</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Country / Region</Label>
                  <select className={selectStyle} value={filters.geography} onChange={(e) => setFilters({ ...filters, geography: e.target.value })}>
                    <option value="">Any region</option>
                    {geographies.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label>From</Label>
                    <Input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>To</Label>
                    <Input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
                  </div>
                </div>
                <div className="flex justify-between pt-1">
                  <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>Reset</Button>
                  <Button size="sm" onClick={() => setShowFilters(false)}>Done</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {checklistProfileId && (
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--primary-light)] px-[var(--space-lg)] py-2 text-xs text-[var(--primary)]">
            <span>Showing cases whose saved checklist snapshot used <b>{checklistProfileId === 'default' ? 'the organization default' : checklistProfileId}</b>.</span>
            <Link href="/cases" className="shrink-0 font-semibold hover:underline">Clear profile filter</Link>
          </div>
        )}

        {/* case-type tabs */}
        <div style={{ padding: '8px var(--space-lg)', borderBottom: '1px solid var(--border)' }} className="flex items-center gap-1 overflow-x-auto">
          {CASE_TYPES.map((t) => {
            const active = typeFilter === t;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className="shrink-0 transition-colors"
                style={{
                  fontSize: 'var(--text-xs)',
                  fontWeight: active ? 600 : 500,
                  padding: '5px 10px',
                  borderRadius: '999px',
                  backgroundColor: active ? 'var(--primary-light)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text-secondary)',
                  border: active ? '1px solid var(--primary)' : '1px solid transparent',
                  whiteSpace: 'nowrap',
                }}
              >
                {t} <span aria-label={`${caseTypeCounts[t]} cases`} style={{ marginLeft: '4px', fontWeight: 700 }}>{caseTypeCounts[t]}</span>
              </button>
            );
          })}
        </div>

        {/* compact summary counts */}
        {!isLoading && !isError && (cases?.length ?? 0) > 0 && (
          <div style={{ padding: '8px var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }} className="flex items-center gap-4 flex-wrap">
            {([
              ['All Cases', counts.all, '' as const],
              ['In Progress', counts.inProgress, 'In Progress' as const],
              ['Human Review', counts.humanReview, 'Human Review' as const],
              ['Waiting', counts.waiting, 'Waiting' as const],
              ['Blocked', counts.blocked, 'Blocked' as const],
              ['Completed', counts.completed, 'Completed' as const],
            ] as const)
              .filter(([, n], i) => i === 0 || n > 0)
              .map(([label, n, statusValue]) => {
                const active = filters.status === statusValue || (statusValue === '' && !filters.status);
                return (
                  <button
                    key={label}
                    onClick={() => setFilters({ ...filters, status: statusValue })}
                    className="flex items-center gap-1.5"
                    style={{ fontSize: 'var(--text-xs)', fontWeight: active ? 700 : 500, color: active ? 'var(--primary)' : 'var(--text-secondary)' }}
                  >
                    {label}
                    <span style={{ fontWeight: 700, color: active ? 'var(--primary)' : 'var(--text-primary)' }}>{n}</span>
                  </button>
                );
              })}
          </div>
        )}

        {/* desktop / tablet table */}
        <div className="overflow-x-auto hidden md:block">
          <table className="w-full text-left" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '2px solid var(--border)' }}>
                {['Case', 'Worker', 'Case Type', 'Effective Date', 'Gates', 'Status', 'Owner / Agent', 'Action'].map((h, i) => (
                  <th
                    key={h}
                    className={cn((h === 'Effective Date' || h === 'Owner / Agent' || h === 'Gates') && 'hidden lg:table-cell')}
                    style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600, textAlign: i === 7 ? 'right' : 'left' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className={cn((j === 3 || j === 4 || j === 6) && 'hidden lg:table-cell')} style={{ padding: '14px var(--space-lg)' }}>
                        <div className="animate-pulse rounded" style={{ height: '12px', width: j === 0 ? '120px' : '70px', backgroundColor: 'var(--surface-alt)' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : isError ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 16px', textAlign: 'center' }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Cases couldn't be loaded</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>Try again or contact your administrator if the issue continues.</div>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Retry</Button>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 16px', textAlign: 'center' }}>
                    {(cases?.length ?? 0) === 0 ? (
                      <>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>No HR operations cases yet</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {isDevelopmentDemo
                            ? 'Add the offline Demo set to view one safe sample for every employee-lifecycle family.'
                            : 'Cases created in this organization will appear here. Demo samples are never added to customer workspaces.'}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>No cases found</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>No cases match the selected filters.</div>
                        {anyFilterActive && <Button size="sm" variant="outline" className="mt-3" onClick={clearAll}>Clear filters</Button>}
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((c) => {
                  const status = statusOf(c);
                  const owner = ownerOf(c);
                  return (
                    <tr
                      key={c.id}
                      className="group transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      tabIndex={0}
                      aria-label={`Open case ${caseIdOf(c)} — ${caseTitleOf(c)} for ${c.workerName}`}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--primary-light)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                          e.preventDefault();
                          setLocation(`/cases/${c.id}`);
                        }
                      }}
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest('a') && !(e.target as HTMLElement).closest('button')) {
                          setLocation(`/cases/${c.id}`);
                        }
                      }}
                    >
                      <td style={{ padding: '12px var(--space-lg)' }}>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{caseTitleOf(c)}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono, monospace)' }}>{caseIdOf(c)}</div>
                      </td>
                      <td style={{ padding: '12px var(--space-lg)' }}>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{c.workerName}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>{c.workerEmail}</div>
                       <WorkforceTags c={c} />
                      </td>
                      <td style={{ padding: '12px var(--space-lg)' }}>
                        <CaseTypeBadge type={caseTypeOf(c)} />
                      </td>
                      <td className="hidden lg:table-cell whitespace-nowrap" style={{ padding: '12px var(--space-lg)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                        {format(new Date(c.joiningDate), 'MMM d, yyyy')}
                      </td>
                      <td className="hidden lg:table-cell" style={{ padding: '12px var(--space-lg)' }}>
                        {c.gateways ? <CompactGates gateways={c.gateways} /> : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>N/A</span>}
                      </td>
                      <td style={{ padding: '12px var(--space-lg)' }}>
                        <HroStatusBadge status={status} />
                      </td>
                      <td className="hidden lg:table-cell" style={{ padding: '12px var(--space-lg)' }}>
                        <OwnerCell owner={owner} />
                      </td>
                      <td style={{ padding: '12px var(--space-lg)', textAlign: 'right' }}>
                        <Link href={`/cases/${c.id}`} className="hover:underline" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--primary)' }} onClick={(e) => e.stopPropagation()}>
                          View Details
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* mobile cards */}
        <div className="md:hidden">
          {isLoading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading...</div>
          ) : isError ? (
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Cases couldn't be loaded</div>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Retry</Button>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {(cases?.length ?? 0) === 0 ? 'No HR operations cases yet.' : 'No cases match the selected filters.'}
            </div>
          ) : (
            filtered.map((c) => {
              const status = statusOf(c);
              return (
                <button
                  key={c.id}
                  className="w-full text-left"
                  style={{ padding: '12px var(--space-lg)', borderBottom: '1px solid var(--border)' }}
                  onClick={() => setLocation(`/cases/${c.id}`)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{caseTitleOf(c)}</span>
                    <HroStatusBadge status={status} />
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{c.workerName}</span>
                    <CaseTypeBadge type={caseTypeOf(c)} />
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>{caseIdOf(c)}</div>
                    {c.gateways && <CompactGates gateways={c.gateways} />}
                  </div>
                   <WorkforceTags c={c} />
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function OwnerCell({ owner }: { owner: { name: string; kind: 'AI Agent' | 'Human Reviewer' } }) {
  const Icon = owner.kind === 'AI Agent' ? Bot : User;
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center justify-center shrink-0 rounded-full" style={{ width: '24px', height: '24px', backgroundColor: owner.kind === 'AI Agent' ? 'var(--primary-light)' : 'var(--surface-soft)', color: owner.kind === 'AI Agent' ? 'var(--primary)' : 'var(--status-amber)' }}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{owner.name}</div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{owner.kind}</div>
      </div>
    </div>
  );
}

function RequiredFieldLabel({
  children,
  htmlFor,
  required = true,
}: {
  children: React.ReactNode;
  htmlFor: string;
  required?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor}>
      {children}
      {required && (
        <>
          <span className="ml-1 text-[var(--status-red)]" aria-hidden="true">*</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </Label>
  );
}

export function NewCaseForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const createCase = useCreateOnboardingCase();
  const currentOrganization = useGetCurrentOrganization();
  const [, setLocation] = useLocation();
  const jobProfiles = useQuery({ queryKey: ['onboarding', 'job-profiles'], queryFn: listJobProfiles });
  const [channelPref, setChannelPref] = useState('both');
  const [phone, setPhone] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [classificationPreview, setClassificationPreview] = useState(() => intakeClassification({}));
  const needsPhone = channelPref !== 'email' && !phone.trim();
  
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data = {
      workerName: fd.get('workerName') as string,
      workerEmail: fd.get('workerEmail') as string,
      workerPhone: fd.get('workerPhone') as string || undefined,
      channelPreference: fd.get('channelPreference') as 'email' | 'whatsapp' | 'both',
      hireType: fd.get('hireType') as string,
      workerCategory: fd.get('workerCategory') as string,
      workerBand: fd.get('workerBand') as string || undefined,
      // Gate A is released only by the post-creation, authority-bound
      // confirmation workflow; intake cannot mark it complete.
      offerAcceptanceComplete: false,
      role: fd.get('role') as string,
      department: fd.get('department') as string,
      geography: fd.get('geography') as string,
      legalEntity: fd.get('legalEntity') as string,
      managerName: fd.get('managerName') as string,
      recruiterName: fd.get('recruiterName') as string,
      joiningDate: fd.get('joiningDate') as string,
      urgency: fd.get('urgency') as string,
       jobProfileId: fd.get('jobProfileId') as string || undefined,
      workforceContext: {
        roleFamily: fd.get('roleFamily') as string || undefined,
        workCountry: fd.get('workCountry') as string || undefined,
        site: fd.get('site') as string || undefined,
        workEnvironment: (fd.get('workEnvironment') as 'office' | 'remote' | 'site' | 'field' | 'mixed') || undefined,
        hiringMode: (fd.get('hiringMode') as 'individual' | 'batch' | 'seasonal') || undefined,
        batchId: fd.get('batchId') as string || undefined,
        payBasis: fd.get('payBasis') as string || undefined,
        shiftPattern: fd.get('shiftPattern') as string || undefined,
        hazards: (fd.get('hazards') as string).split(',').map((item) => item.trim()).filter(Boolean),
        requiredLicenses: (fd.get('requiredLicenses') as string).split(',').map((item) => item.trim()).filter(Boolean),
        assistedIntake: parseWorkforceTriState(fd.get('assistedIntake')),
        siteExposure: parseWorkforceTriState(fd.get('siteExposure')),
        safetyCritical: parseWorkforceTriState(fd.get('safetyCritical')),
        languagePreference: fd.get('languagePreference') as string || undefined,
      },
    };
    
    setSubmitError(null);
    createCase.mutate({ data }, {
      onSuccess: (created) => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        onClose();
        setLocation(`/cases/${created.id}`);
      },
      onError: (error: any) => {
        const serverMessage = error?.response?.data?.message || error?.message;
        setSubmitError(serverMessage || 'The case could not be created. Please try again.');
      },
    });
  };

  return (
    <Card className="mb-6 shadow-md">
      <div style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>New Case</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>
      <form onSubmit={handleSubmit} onInput={(event) => {
        const values = new FormData(event.currentTarget);
        setClassificationPreview(intakeClassification({
          workEnvironment: values.get('workEnvironment') as string,
          siteExposure: values.get('siteExposure') as string,
          safetyCritical: values.get('safetyCritical') as string,
          hazards: values.get('hazards') as string,
        }));
      }} className="p-[var(--space-lg)] space-y-4">
        <p className="text-xs text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--status-red)]" aria-hidden="true">*</span>{' '}
          Required field
        </p>
        <p className="rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm">
          General intake cannot save free-form candidate or recruiter notes, including ordinary non-sensitive notes, or accessibility and medical details. Do not enter these in other fields. No specialist handoff is available from this form.
        </p>
        {currentOrganization.data?.demoProfile === 'administrator' && (
          <p className="rounded border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950" role="status">
            Your server-authorized Demo Administrator profile will create an offline synthetic case in Demo Organization. No emails, messages, provider actions, portal links, SLA enrollment, or orchestration will run.
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="workerName">Worker Name</RequiredFieldLabel>
            <Input id="workerName" name="workerName" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="workerEmail">Email</RequiredFieldLabel>
            <Input id="workerEmail" name="workerEmail" type="email" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="workerPhone" required={channelPref === 'whatsapp'}>Phone (E.164)</RequiredFieldLabel>
            <Input id="workerPhone" name="workerPhone" placeholder="+1234567890" value={phone} onChange={(e) => setPhone(e.target.value)} required={channelPref === 'whatsapp'} />
            {needsPhone && (
              <p className="text-[11px] leading-snug" style={{ color: 'var(--status-amber)' }}>
                {channelPref === 'whatsapp'
                  ? 'WhatsApp is selected — a phone number is required (the agent falls back to email without one).'
                  : 'Without a phone number, WhatsApp messages are skipped and only email is used.'}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="channelPreference">Contact Channel</RequiredFieldLabel>
            <select id="channelPreference" name="channelPreference" value={channelPref} onChange={(e) => setChannelPref(e.target.value)} className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="email">Email only</option>
              <option value="whatsapp">WhatsApp only</option>
              <option value="both">Email + WhatsApp</option>
            </select>
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="hireType">Hire Type</RequiredFieldLabel>
            <select id="hireType" name="hireType" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="external-fte">External FTE</option>
              <option value="contractor">Contractor</option>
              <option value="rehire">Rehire</option>
              <option value="internal-transfer">Internal Transfer</option>
            </select>
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="workerCategory">Worker Category</RequiredFieldLabel>
            <select id="workerCategory" name="workerCategory" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="employee">Employee</option>
              <option value="contractor">Contractor</option>
              <option value="vendor">Vendor</option>
              <option value="intern">Intern</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Worker Band (Optional)</Label>
            <Input name="workerBand" placeholder="e.g. L4, Executive" />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="role">Role</RequiredFieldLabel>
            <Input id="role" name="role" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="department">Department</RequiredFieldLabel>
            <Input id="department" name="department" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="geography">Geography</RequiredFieldLabel>
            <Input id="geography" name="geography" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="legalEntity">Legal Entity</RequiredFieldLabel>
            <Input id="legalEntity" name="legalEntity" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="joiningDate">Joining Date</RequiredFieldLabel>
            <Input id="joiningDate" name="joiningDate" type="date" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="managerName">Manager</RequiredFieldLabel>
            <Input id="managerName" name="managerName" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="recruiterName">Recruiter</RequiredFieldLabel>
            <Input id="recruiterName" name="recruiterName" required />
          </div>
          <div className="space-y-1">
            <RequiredFieldLabel htmlFor="urgency">Urgency</RequiredFieldLabel>
            <select id="urgency" name="urgency" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
           <div className="col-span-1 space-y-3 mt-2 pt-3 border-t border-[var(--border)] sm:col-span-2 md:col-span-3">
             <div>
               <Label className="font-semibold">Work context for policy routing</Label>
               <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Classifies the job from explicit work conditions only. Leave unknown facts blank; they will be shown as needs review rather than inferred.</p>
             </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
               <div className="space-y-1"><Label>Role Family</Label><Input name="roleFamily" placeholder="e.g. Operations" /></div>
               <div className="space-y-1"><Label>Work Environment</Label><select name="workEnvironment" defaultValue="" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] text-[var(--text-sm)]"><option value="">Unknown / needs review</option><option value="office">Office</option><option value="remote">Remote</option><option value="site">Site</option><option value="field">Field</option><option value="mixed">Mixed</option></select></div>
               <div className="space-y-1"><Label>Work Country</Label><Input name="workCountry" placeholder="e.g. India" /></div>
               <div className="space-y-1"><Label>Site</Label><Input name="site" placeholder="Site or facility" /></div>
               <div className="space-y-1"><Label>Pay Basis</Label><Input name="payBasis" placeholder="Salary or wage" /></div>
               <div className="space-y-1"><Label>Hiring Mode</Label><select name="hiringMode" defaultValue="individual" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] text-[var(--text-sm)]"><option value="individual">Individual</option><option value="batch">Batch</option><option value="seasonal">Seasonal</option></select></div>
               <div className="space-y-1"><Label>Batch ID</Label><Input name="batchId" placeholder="Optional batch" /></div>
               <div className="space-y-1"><Label>Shift Pattern</Label><Input name="shiftPattern" placeholder="e.g. Rotating" /></div>
               <div className="space-y-1"><Label>Required Licenses</Label><Input name="requiredLicenses" placeholder="Comma-separated" /></div>
                <div className="col-span-1 space-y-1 sm:col-span-2 md:col-span-3"><Label>Hazards / site conditions</Label><Input name="hazards" placeholder="Comma-separated; e.g. forklift traffic, heights" /></div>
             </div>
             <div className="flex flex-wrap gap-x-5 gap-y-2 text-[var(--text-xs)] text-[var(--text-secondary)]">
               <label className="flex items-center gap-2">Site exposure <select name="siteExposure" defaultValue="" className="h-7 rounded border border-[var(--border)] bg-[var(--surface)] px-1"><option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>
               <label className="flex items-center gap-2">Safety-critical duties <select name="safetyCritical" defaultValue="" className="h-7 rounded border border-[var(--border)] bg-[var(--surface)] px-1"><option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>
               <label className="flex items-center gap-2">Assisted intake requested <select name="assistedIntake" defaultValue="" className="h-7 rounded border border-[var(--border)] bg-[var(--surface)] px-1"><option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>
               <label className="flex items-center gap-2">Language preference <Input name="languagePreference" className="h-7 w-32" /></label>
             </div>
              <div className={cn('rounded border p-3 text-xs', classificationPreview.label === 'needs-review' ? 'border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]' : 'border-[var(--status-green)]/30 bg-[var(--status-green-bg)] text-[var(--status-green-fg)]')}>
                <strong>Explainable workforce classification: {classificationPreview.label.replace(/-/g, ' ')}</strong>
                <p className="mt-1">{classificationPreview.rationale}</p>
                <p className="mt-1 opacity-90">{classificationPreview.uncertainty}</p>
              </div>
           </div>
           <div className="space-y-1">
             <Label>Reusable job profile</Label>
             <select name="jobProfileId" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)]">
               <option value="">Use explicit intake context only</option>
               {jobProfiles.data?.filter((profile) => profile.enabled).map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · v{profile.version}</option>)}
             </select>
             <p className="text-[10px] text-[var(--text-muted)]">The selected version is snapshotted; person-specific context below may add known facts.</p>
           </div>
        </div>
         <div className="flex flex-col-reverse gap-3 pt-4 mt-2 sm:flex-row sm:items-center sm:justify-end sm:gap-4" style={{ borderTop: '1px solid var(--border)' }}>
          {submitError && (
            <p className="text-[12px] font-medium m-0" style={{ color: 'var(--status-red)' }} role="alert">
              {submitError}
            </p>
          )}
          <Button type="submit" disabled={createCase.isPending}>
            {createCase.isPending ? 'Creating...' : currentOrganization.data?.demoProfile === 'administrator' ? 'Create Offline Synthetic Case' : 'Create Case'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
