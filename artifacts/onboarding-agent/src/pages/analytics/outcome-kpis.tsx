import React, { useMemo } from 'react';
import { 
  useGetOnboardingOutcomeKpis, 
  getGetOnboardingOutcomeKpisQueryKey,
  type OnbOutcomeKpi
} from '@workspace/api-client-react';
import { CheckCircle2, XCircle, AlertCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui-shared';

interface OutcomeKpisProps {
  period: string;
  region: string;
  domain: string;
  caseType: string;
  agent: string;
}

interface StaticKpiDef {
  id: string;
  label: string;
  targetLabel: string;
  definition: string;
}

export const STATIC_KPIS: StaticKpiDef[] = [
  { id: 'cycle-time', label: 'Onboarding Cycle Time', targetLabel: '≤ 7 days', definition: 'Time from offer acceptance to completion of all mandatory onboarding steps.' },
  { id: 'day1-readiness', label: 'Day-1 Readiness Rate', targetLabel: '≥ 98%', definition: 'Percentage of new hires with all access, hardware, and orientation scheduled by Day 1.' },
  { id: 'doc-completeness', label: 'Document Completeness at Intake', targetLabel: '≥ 90%', definition: 'Percentage of new hires providing all required documents accurately on first submission.' },
  { id: 'bgv-turnaround', label: 'BGV Turnaround', targetLabel: '≤ 5 days', definition: 'Average days to complete Background Verification from initiation.' },
  { id: 'provisioning-on-time', label: 'Provisioning On-Time Rate', targetLabel: '≥ 95%', definition: 'Percentage of IT and facility provisioning requests completed by J-2.' },
  { id: 'enps', label: 'New-Hire Experience (eNPS)', targetLabel: '≥ +40', definition: 'Employee Net Promoter Score measured from the 30-day onboarding survey.' },
  { id: 'attrition', label: '0–90 Day Attrition', targetLabel: '≤ 3%', definition: 'Percentage of new hires departing the organization voluntarily or involuntarily within 90 days.' }
];

export function formatValue(val: number | null, unit: string) {
  if (val === null) return null;
  if (unit === 'percent') return `${val}%`;
  if (unit === 'days') return `${val} days`;
  if (unit === 'score') return val > 0 ? `+${val}` : `${val}`;
  return `${val}`;
}

export function OutcomeKpisGrid({
  metrics,
  isLoading,
  isError,
  cohortLabel,
  caseCount,
  onRetry
}: {
  metrics: OnbOutcomeKpi[];
  isLoading: boolean;
  isError: boolean;
  cohortLabel?: string;
  caseCount?: number;
  onRetry?: () => void;
}) {
  return (
    <section className="mb-14">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Business Outcomes</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">
            Cohort outcome metrics based on current filters. 
            <span className="font-semibold text-[var(--text-secondary)] ml-1">
              (Note: Agent filter does not apply to cohort outcomes)
            </span>
          </p>
          {cohortLabel && (
            <p className="text-[13px] font-medium text-[var(--primary)] mt-1.5 bg-[var(--primary-light)] px-2 py-0.5 rounded-md inline-block">
              {cohortLabel} ({caseCount} cases)
            </p>
          )}
        </div>
        
        {isError && (
          <div className="bg-[var(--status-red-bg)] text-[var(--status-red-fg)] px-4 py-2 rounded-md text-[13px] font-medium flex items-center gap-2 border border-[var(--status-red)]">
            <AlertTriangle className="w-4 h-4" />
            Failed to load outcomes
            <Button variant="outline" size="sm" onClick={onRetry} className="ml-2 h-7 bg-white text-[var(--status-red-fg)] hover:bg-red-50 border-red-200">
              Retry
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {STATIC_KPIS.map((staticKpi) => {
          const serverKpi = metrics.find(m => m.label === staticKpi.label || m.id === staticKpi.id);
          const kpi = serverKpi || (staticKpi as any);
          
          const isMissing = !serverKpi || kpi.value === null || kpi.value === undefined || kpi.status === 'not-collected' || kpi.status === 'insufficient-data';
          
          const displayValue = (isError || isMissing) ? null : formatValue(kpi.value, kpi.unit || 'percent');
          
          const met = kpi.status === 'met';
          const missed = kpi.status === 'missed';
          
          return (
            <div key={staticKpi.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)] flex flex-col relative overflow-hidden transition-all hover:shadow-[var(--shadow-md)]">
              {isLoading && !serverKpi && (
                <div className="absolute inset-0 bg-white/50 backdrop-blur-[1px] z-10 flex items-center justify-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-[var(--primary)] border-t-transparent"></div>
                </div>
              )}
              
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)] leading-tight">{staticKpi.label}</h3>
                <span className="text-[11px] font-bold uppercase tracking-wider bg-[var(--surface-alt)] text-[var(--text-muted)] px-2 py-1 rounded">
                  Target: {serverKpi?.targetLabel || staticKpi.targetLabel}
                </span>
              </div>
              
              <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed mb-5 min-h-[40px]">
                {serverKpi?.definition || staticKpi.definition}
              </p>
              
              <div className="mt-auto border-t border-[var(--border)] pt-4 flex flex-col gap-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">Baseline: {serverKpi?.baseline || 'TBD'}</div>
                
                {(isError || isMissing) ? (
                  <div className="mb-1">
                    <div className="text-[14px] font-semibold text-[var(--text-muted)] flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4 opacity-70" />
                      {isError ? 'Unavailable' : 'Not yet measured'}
                    </div>
                  </div>
                ) : (
                  <div className="mb-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[28px] font-bold text-[var(--text-primary)] leading-none tracking-tight">
                        {displayValue}
                      </span>
                      {met && (
                        <span className="text-[12px] font-bold text-[var(--status-green-fg)] bg-[var(--status-green-bg)] px-2 py-0.5 rounded flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Target met
                        </span>
                      )}
                      {missed && (
                        <span className="text-[12px] font-bold text-[var(--status-red-fg)] bg-[var(--status-red-bg)] px-2 py-0.5 rounded flex items-center gap-1">
                          <XCircle className="w-3.5 h-3.5" /> Target missed
                        </span>
                      )}
                    </div>
                  </div>
                )}
                
                {kpi.note && (
                  <div className="text-[12px] text-[var(--text-muted)] opacity-90 leading-snug">
                    {kpi.note}
                  </div>
                )}
                {(!isError && !serverKpi) && (
                  <div className="text-[12px] text-[var(--text-muted)] opacity-90 leading-snug">
                    Explicitly missing from server response.
                  </div>
                )}
                
                {(kpi.eligibleCount !== undefined || kpi.sampleSize !== undefined || kpi.unknownCount !== undefined) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-[var(--text-muted)]">
                    {kpi.eligibleCount !== undefined && <span>Eligible: <strong className="text-[var(--text-secondary)]">{kpi.eligibleCount}</strong></span>}
                    {kpi.sampleSize !== undefined && <span>Sample: <strong className="text-[var(--text-secondary)]">{kpi.sampleSize}</strong></span>}
                    {(kpi.unknownCount !== undefined && kpi.unknownCount > 0) && (
                      <span>Missing: <strong className="text-[var(--text-secondary)]">{kpi.unknownCount}</strong></span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function OutcomeKpis({ period, region, domain, caseType, agent }: OutcomeKpisProps) {
  const params = useMemo(() => {
    return {
      period: period as '7' | '30' | '90' | 'All',
      ...(region !== 'All regions' ? { region } : {}),
      ...(caseType !== 'All cases' ? { hireType: caseType } : {}),
      ...(domain !== 'All domains' ? { domain: domain as any } : {})
    };
  }, [period, region, caseType, domain]);

  const { data, isLoading, isError, refetch } = useGetOnboardingOutcomeKpis(params, {
    query: {
      queryKey: getGetOnboardingOutcomeKpisQueryKey(params),
      staleTime: 60000,
      retry: 1
    }
  });

  return (
    <OutcomeKpisGrid
      metrics={data?.metrics || []}
      isLoading={isLoading}
      isError={isError}
      cohortLabel={data?.cohortLabel}
      caseCount={data?.caseCount}
      onRetry={() => refetch()}
    />
  );
}
