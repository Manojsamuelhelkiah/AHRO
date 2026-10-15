import React, { useMemo, useState } from 'react';
import { operationalReportingPopulation } from '../lib/operational-reporting';
import {
  useGetOnboardingAnalytics, getGetOnboardingAnalyticsQueryKey,
  useListOnboardingCases, getListOnboardingCasesQueryKey,
  useListOnboardingApprovals, getListOnboardingApprovalsQueryKey,
  getGetHroEmailIntakeQueryKey,
  // @ts-ignore
  getGetOnboardingOutcomeKpisQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader, LoadingBlock, Button } from '@/components/ui-shared';
import { ShieldAlert, AlertTriangle, AlertOctagon, Timer, RefreshCw, ChevronDown, Bot } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';
import { Link } from 'wouter';
import { statusOf, caseTypeOf } from './cases/index';
import { CASE_TYPES } from './cases/case-presentation';

import { OutcomeKpis } from './analytics/outcome-kpis';
import { BottleneckSimulator } from './analytics/bottleneck-simulator';
import { EmailTurnaroundReport } from './analytics/email-turnaround';
import { useEmailScope } from './email-intake/common';

export function AnalyticsPage() {
  const queryClient = useQueryClient();
  const { scope: emailScope } = useEmailScope();
  
  const { data: analytics, isLoading: analyticsLoading } = useGetOnboardingAnalytics({
    query: {
      queryKey: getGetOnboardingAnalyticsQueryKey(),
      refetchInterval: (query) => (query.state.data && !query.state.data.narrative ? 4000 : false),
    },
  });

  const { data: casesData, isLoading: casesLoading } = useListOnboardingCases();
  const { data: approvalsData, isLoading: approvalsLoading } = useListOnboardingApprovals({ status: 'all' });

  const [period, setPeriod] = useState<string>('30');
  const [domain, setDomain] = useState<string>('All domains');
  const [region, setRegion] = useState<string>('All regions');
  const [caseType, setCaseType] = useState<string>('All cases');
  const [agent, setAgent] = useState<string>('All agents');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [...getGetHroEmailIntakeQueryKey(), emailScope], exact: true });
    queryClient.invalidateQueries({ queryKey: getGetOnboardingAnalyticsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey() });
    try {
      const params = {
        period: period as '7' | '30' | '90' | 'All',
        ...(region !== 'All regions' ? { region } : {}),
        ...(caseType !== 'All cases' ? { hireType: caseType } : {}),
        ...(domain !== 'All domains' ? { domain: domain as any } : {})
      };
      queryClient.invalidateQueries({ queryKey: getGetOnboardingOutcomeKpisQueryKey(params) });
    } catch(e) {}
  };

  const { cases: allCases, approvals: allApprovals } = operationalReportingPopulation(casesData ?? [], approvalsData ?? []);

  const regions = useMemo(() => Array.from(new Set(allCases.map(c => c.geography).filter(Boolean))).sort(), [allCases]);
  const caseTypes = useMemo(() => Array.from(new Set(allCases.map(c => c.hireType).filter(Boolean))).sort(), [allCases]);
  const agents = useMemo(() => Array.from(new Set(allApprovals.map(a => a.agent).filter(Boolean))).sort(), [allApprovals]);

  const cutoffDate = useMemo(() => {
    if (period === 'All') return null;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(period, 10));
    return d.toISOString();
  }, [period]);

  const filteredCases = useMemo(() => {
    return allCases.filter(c => {
      if (cutoffDate && c.createdAt < cutoffDate) return false;
      if (domain !== 'All domains') {
        const caseDomain = caseTypeOf(c);
        if (caseDomain !== domain) return false;
      }
      if (region !== 'All regions' && c.geography !== region) return false;
      if (caseType !== 'All cases' && c.hireType !== caseType) return false;
      return true;
    });
  }, [allCases, cutoffDate, domain, region, caseType]);

  // Approvals are always constrained to the filtered case population so every
  // approval-derived metric shares the same denominator as the case metrics.
  const filteredApprovals = useMemo(() => {
    const caseIdSet = new Set(filteredCases.map(c => c.id));
    return allApprovals.filter(a => {
      if (!caseIdSet.has(a.caseId)) return false;
      if (agent !== 'All agents' && a.agent !== agent) return false;
      return true;
    });
  }, [allApprovals, filteredCases, agent]);

  // For autonomy we need whether a case EVER required human review (not clipped
  // to the selected period), otherwise an old approval outside the window would
  // make a human-reviewed case look autonomous.
  const everReviewedCaseIds = useMemo(() => new Set(allApprovals.map(a => a.caseId)), [allApprovals]);

  // Derived Metrics for Operational Performance
  const { totalCases, activeCases, autonomousRate, interventionRate, exceptionRate } = useMemo(() => {
    const total = filteredCases.length;
    const active = filteredCases.filter(c => {
      const stage = (c.lifecycleStage || '').toLowerCase();
      const orch = (c.orchestrationStatus || '').toLowerCase();
      return stage !== 'complete' && stage !== 'completed' && orch !== 'done';
    });
    
    const completed = filteredCases.filter(c => {
      const stage = (c.lifecycleStage || '').toLowerCase();
      return stage === 'complete' || stage === 'completed';
    });

    const exceptions = filteredCases.filter(c => (c.lifecycleStage || '').toLowerCase() === 'exception');
    
    // Autonomy uses all-time review history, not the period-clipped set.
    const measuredCompleted = completed.filter(c => !c.offlineSample);
    const autonomous = measuredCompleted.filter(c => !everReviewedCaseIds.has(c.id));
    const reviewedInScope = new Set(filteredCases.filter(c => everReviewedCaseIds.has(c.id)).map(c => c.id));

    const autoRate = measuredCompleted.length > 0 ? (autonomous.length / measuredCompleted.length) * 100 : null;
    const intRate = total > 0 ? (reviewedInScope.size / total) * 100 : null;
    const excRate = total > 0 ? (exceptions.length / total) * 100 : null;

    return { totalCases: total, activeCases: active, completedCases: completed, exceptionCases: exceptions, autonomousRate: autoRate, interventionRate: intRate, exceptionRate: excRate };
  }, [filteredCases, everReviewedCaseIds]);

  // Derived Metrics for Agent Performance
  const agentStats = useMemo(() => {
    const stats = new Map<string, { cases: Set<number>, humanReviews: number, exceptions: number }>();
    for (const a of filteredApprovals) {
      if (!a.agent) continue;
      if (!stats.has(a.agent)) stats.set(a.agent, { cases: new Set(), humanReviews: 0, exceptions: 0 });
      const st = stats.get(a.agent)!;
      st.cases.add(a.caseId);
      st.humanReviews++;
      if (a.hitlPattern === 'hard-block') st.exceptions++;
    }
    
    const rows = Array.from(stats.entries()).map(([ag, st]) => ({
      name: ag.charAt(0).toUpperCase() + ag.slice(1) + ' Agent',
      cases: st.cases.size as number | string,
      autonomous: '—',
      humanReviews: st.humanReviews as number | string,
      sla: '—',
      exceptions: st.exceptions as number | string,
    }));
    
    const required = ['Payroll Agent', 'Compliance Agent', 'Helpdesk Agent'];
    for (const req of required) {
      rows.push({ name: req, cases: '—', autonomous: '—', humanReviews: '—', sla: '—', exceptions: '—' });
    }
    return rows;
  }, [filteredApprovals]);

  // Derived Metrics for Risk & Exception Intelligence
  const { slaAtRisk, pendingApprovalsList, hardBlockedCases, policyExceptions } = useMemo(() => {
    const atRisk = filteredCases.filter(c => {
      const stage = (c.lifecycleStage || '').toLowerCase();
      if (stage === 'complete' || stage === 'completed') return false;
      const days = (new Date(c.joiningDate).getTime() - Date.now()) / 86400000;
      if (days < 0 || days > 7) return false;
      return c.orchestrationStatus === 'blocked' || c.orchestrationStatus === 'waiting-approval' || (c.workstreams ?? []).some(w => (w.blockers ?? []).length > 0);
    });
    
    const pApp = filteredApprovals.filter(a => a.status === 'pending');
    const hBlocked = filteredCases.filter(c => c.orchestrationStatus === 'blocked');
    // Policy exceptions are hard-block governance stops only — ruleRef is an
    // SME rule reference, not an exception marker.
    const pExc = filteredApprovals.filter(a => a.hitlPattern === 'hard-block');
    
    return { slaAtRisk: atRisk, pendingApprovalsList: pApp, hardBlockedCases: hBlocked, policyExceptions: pExc };
  }, [filteredCases, filteredApprovals]);

  // Derived Metrics for Decision Intelligence
  const { ruleVolumes, outcomeApproved, outcomeRejected, approveBeforeAct, hardBlock } = useMemo(() => {
    const rules = new Map<string, number>();
    let oApp = 0, oRej = 0, aBA = 0, hB = 0;
    
    for (const a of filteredApprovals) {
      if (a.ruleRef) rules.set(a.ruleRef, (rules.get(a.ruleRef) || 0) + 1);
      if (a.hitlPattern === 'hard-block') hB++;
      else if (a.hitlPattern === 'approve-before-act') aBA++;
      if (a.status === 'approved') oApp++;
      else if (a.status === 'rejected') oRej++;
    }
    
    return {
      ruleVolumes: Array.from(rules.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5),
      outcomeApproved: oApp, outcomeRejected: oRej, approveBeforeAct: aBA, hardBlock: hB
    };
  }, [filteredApprovals]);

  // Derived Metrics for HRO Domain Intelligence
  const domainStats = useMemo(() => {
    const domainsList = CASE_TYPES.filter(domain => domain !== 'All Cases');
    return domainsList.map(dom => {
        const dcases = filteredCases.filter(c => caseTypeOf(c) === dom);
        if (dcases.length === 0) return { domain: dom, volume: 0, autonomy: '—', intervention: '—', exceptions: 0 };
        
        const dcomp = dcases.filter(c => { const st = (c.lifecycleStage || '').toLowerCase(); return !c.offlineSample && (st === 'complete' || st === 'completed'); });
        const dapp = filteredApprovals.filter(a => dcases.some(dc => dc.id === a.caseId));
        const dSet = new Set(dapp.map(a => a.caseId));
        const dAuto = dcomp.filter(c => !dSet.has(c.id));
        
        return {
          domain: dom,
          volume: dcases.length,
          autonomy: dcomp.length > 0 ? `${Math.round((dAuto.length / dcomp.length) * 100)}%` : '—',
          intervention: `${Math.round((dSet.size / dcases.length) * 100)}%`,
          exceptions: dcases.filter(c => (c.lifecycleStage || '').toLowerCase() === 'exception').length,
        };
    });
  }, [filteredCases, filteredApprovals]);

  const isLoading = casesLoading || approvalsLoading || analyticsLoading;

  return (
    <div className="min-w-0 max-w-7xl mx-auto pb-16 pt-2">
      <PageHeader 
        title="HRO Intelligence" 
        subtitle="Authorized online and offline cases are included in totals. Historical examples are not verified business outcomes."
      />

      <div className="flex flex-wrap gap-4 mb-10 items-end bg-[var(--surface)] p-4 rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)]">
        <FilterSelect label="Period" value={period} onChange={setPeriod} options={[{l: 'Last 7 days', v: '7'}, {l: 'Last 30 days', v: '30'}, {l: 'Last 90 days', v: '90'}, {l: 'All time', v: 'All'}]} />
        <FilterSelect label="HRO Domain" value={domain} onChange={setDomain} options={[{l: 'All domains', v: 'All domains'}, ...CASE_TYPES.filter(family => family !== 'All Cases').map(family => ({ l: family, v: family }))]} />
        <FilterSelect label="Region" value={region} onChange={setRegion} options={[{l: 'All regions', v: 'All regions'}, ...regions.map(r => ({l: r, v: r}))]} />
        <FilterSelect label="Case Type" value={caseType} onChange={setCaseType} options={[{l: 'All cases', v: 'All cases'}, ...caseTypes.map(c => ({l: c, v: c}))]} />
        <FilterSelect label="Agent" value={agent} onChange={setAgent} options={[{l: 'All agents', v: 'All agents'}, ...agents.map(a => ({l: a, v: a}))]} />
        
        <Button variant="outline" size="sm" onClick={refresh} className="ml-auto gap-2 h-[34px] px-4 font-semibold text-[var(--text-secondary)]">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      <EmailTurnaroundReport />

      {isLoading && <LoadingBlock>Loading case analytics...</LoadingBlock>}

      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-[12px] font-bold uppercase tracking-wider text-[var(--primary)] m-0">Executive Insight</h2>
        </div>
        <div className="bg-[var(--status-info-bg)] rounded-[var(--radius-lg)] p-5 md:p-8 border border-[var(--border)] shadow-[var(--shadow-sm)]">
          {!analytics?.narrative ? (
            <div className="animate-pulse space-y-3 py-2">
              <div className="h-4 bg-[var(--border-strong)] rounded opacity-50 w-3/4"></div>
              <div className="h-4 bg-[var(--border-strong)] rounded opacity-50 w-1/2"></div>
            </div>
          ) : (
            <p className="text-[15px] md:text-[17px] text-[var(--text-primary)] font-semibold leading-relaxed m-0">
              {analytics.narrative}
            </p>
          )}
          <div className="mt-5 pt-4 border-t border-[rgba(76,66,238,0.15)] flex items-center gap-2 text-[12px] text-[var(--primary)] font-semibold">
            <span>Generated from current HRO operational data</span>
          </div>
        </div>
      </section>

      <OutcomeKpis 
        period={period} 
        region={region} 
        domain={domain} 
        caseType={caseType} 
        agent={agent} 
      />

      <section className="mb-14 mt-12">
        <BottleneckSimulator period={period} region={region} domain={domain} caseType={caseType} />
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Operational Performance</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">How effectively HR work is being executed across the HRO operating model.</p>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-3 gap-6 lg:gap-10">
          <OpMetric 
            label="Autonomous Resolution Rate" 
            value={autonomousRate !== null ? `${Math.round(autonomousRate)}%` : '—'} 
            sub={autonomousRate !== null ? "Eligible completed cases" : "Insufficient data"} 
          />
          <OpMetric 
            label="Human Intervention Rate" 
            value={interventionRate !== null ? `${Math.round(interventionRate)}%` : '—'} 
            sub={interventionRate !== null ? "Cases requiring human review" : "Insufficient data"} 
          />
          <OpMetric 
            label="SLA Performance" 
            value="—" 
            sub="Insufficient data" 
          />
          <OpMetric 
            label="Average Resolution Time" 
            value="—" 
            sub="Insufficient data" 
          />
          <OpMetric 
            label="Exception Rate" 
            value={exceptionRate !== null ? `${Math.round(exceptionRate)}%` : '—'} 
            sub={exceptionRate !== null ? "Cases entering exception paths" : "Insufficient data"} 
          />
          <OpMetric 
            label="Active Case Volume" 
            value={activeCases.length} 
            sub="Current active workload" 
          />
        </div>
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Agent Performance</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">Compare workload, autonomy, intervention, and SLA performance across HR agents.</p>
        </div>
        
        <div className="overflow-x-auto bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)]">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-[var(--surface-alt)] border-b border-[var(--border)]">
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Agent</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Cases</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Autonomous</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Human Review</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">SLA</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Exceptions</th>
              </tr>
            </thead>
            <tbody>
              {agentStats.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-alt)] transition-colors">
                  <td className="py-4 px-5 text-[14px] font-semibold text-[var(--text-primary)] flex items-center gap-2.5">
                    <div className="p-1.5 bg-[var(--primary-light)] rounded-md text-[var(--primary)]">
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    {row.name}
                  </td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.cases}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.autonomous}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.humanReviews}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.sla}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.exceptions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Risk & Exception Intelligence</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">Where HR operations are slowing, escalating, or requiring intervention.</p>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-5">
          <RiskCard title="Day-1 Risk" value={slaAtRisk.length} icon={Timer} color="var(--status-amber)" bg="var(--status-amber-bg)" link="/cases" />
          <RiskCard title="Human Review Backlog" value={pendingApprovalsList.length} icon={AlertTriangle} color="var(--status-amber)" bg="var(--status-amber-bg)" link="/approvals" />
          <RiskCard title="Blocked Cases" value={hardBlockedCases.length} icon={AlertOctagon} color="var(--status-red)" bg="var(--status-red-bg)" link="/cases" />
          <RiskCard title="Policy Exceptions" value={policyExceptions.length} icon={ShieldAlert} color="var(--primary)" bg="var(--primary-light)" link="/guardrails" />
        </div>
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Operational Bottlenecks</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">Identified constraints across the HRO execution model.</p>
        </div>
        
        {!analytics?.bottlenecks || analytics.bottlenecks.length === 0 ? (
          <div className="text-center py-10 bg-[var(--surface-alt)] border border-dashed border-[var(--border)] rounded-[var(--radius-lg)]">
            <p className="text-[14px] font-medium text-[var(--text-muted)]">No significant operational bottlenecks are currently identified.</p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {analytics.bottlenecks.map((b: any, i: number) => (
              <div key={i} className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] flex items-center justify-center font-bold text-[14px]">
                  {b.occurrences}
                </div>
                <div>
                  <h3 className="text-[16px] font-semibold text-[var(--text-primary)] m-0 capitalize">{b.theme.replace(/-/g, ' ')}</h3>
                  <p className="text-[13px] font-semibold text-[var(--primary)] mt-1">{b.occurrences} cases affected</p>
                  <p className="text-[14px] text-[var(--text-secondary)] mt-2.5 leading-relaxed">{b.note}</p>
                  <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-muted)] mt-4">Recommended Action: Review configuration</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Decision Intelligence</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">Where policies and human decisions affect autonomous execution.</p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex flex-col">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-5">Rules Driving Review Volume</h3>
            {ruleVolumes.length === 0 ? (
              <p className="text-[13px] text-[var(--text-muted)] font-medium mt-auto mb-auto">No rule-referenced reviews recorded.</p>
            ) : (
              <ul className="space-y-4">
                {ruleVolumes.map(([rule, count]) => (
                  <li key={rule} className="flex items-center justify-between gap-3">
                    <span className="text-[14px] font-medium text-[var(--text-primary)] truncate flex-1" title={rule}>{rule}</span>
                    <span className="text-[12px] font-bold text-[var(--text-secondary)] bg-[var(--surface-alt)] px-2 py-0.5 rounded">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex flex-col">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-5">Governance Outcomes</h3>
            <div className="flex justify-between items-end mt-auto mb-2">
              <div>
                <span className="block text-[28px] font-bold text-[var(--status-green)] leading-none">{outcomeApproved}</span>
                <span className="text-[13px] font-semibold text-[var(--text-secondary)] mt-2 block">Approved</span>
              </div>
              <div>
                <span className="block text-[28px] font-bold text-[var(--status-red)] leading-none">{outcomeRejected}</span>
                <span className="text-[13px] font-semibold text-[var(--text-secondary)] mt-2 block">Rejected</span>
              </div>
              <div>
                <span className="block text-[28px] font-bold text-[var(--status-amber)] leading-none">{pendingApprovalsList.length}</span>
                <span className="text-[13px] font-semibold text-[var(--text-secondary)] mt-2 block">Pending</span>
              </div>
            </div>
          </div>
          
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex flex-col">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-5">Intervention Types</h3>
            <div className="space-y-5 mt-auto mb-1">
              <div>
                <div className="flex justify-between text-[13px] font-semibold mb-2">
                  <span className="text-[var(--text-secondary)]">Approve Before Act</span>
                  <span className="font-bold text-[var(--text-primary)]">{approveBeforeAct}</span>
                </div>
                <div className="h-2 w-full bg-[var(--surface-alt)] rounded-full overflow-hidden">
                  <div className="h-full bg-[var(--primary)] rounded-full" style={{ width: `${Math.max(0, (approveBeforeAct / ((approveBeforeAct + hardBlock) || 1)) * 100)}%` }}></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[13px] font-semibold mb-2">
                  <span className="text-[var(--text-secondary)]">Hard Block (Exception)</span>
                  <span className="font-bold text-[var(--text-primary)]">{hardBlock}</span>
                </div>
                <div className="h-2 w-full bg-[var(--surface-alt)] rounded-full overflow-hidden">
                  <div className="h-full bg-[var(--status-red)] rounded-full" style={{ width: `${Math.max(0, (hardBlock / ((approveBeforeAct + hardBlock) || 1)) * 100)}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-14">
        <div className="mb-6">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">HRO Domain Intelligence</h2>
          <p className="text-[14px] text-[var(--text-muted)] mt-1">Cross-functional performance across all integrated HR domains.</p>
        </div>
        
        <div className="overflow-x-auto bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)]">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-[var(--surface-alt)] border-b border-[var(--border)]">
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Domain</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Case Volume</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Autonomy</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Intervention</th>
                <th className="py-3.5 px-5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] text-right">Exceptions</th>
              </tr>
            </thead>
            <tbody>
              {domainStats.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-alt)] transition-colors">
                  <td className="py-4 px-5 text-[14px] font-semibold text-[var(--text-primary)]">{row.domain}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.volume}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.autonomy}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.intervention}</td>
                  <td className="py-4 px-5 text-[14px] font-medium text-[var(--text-secondary)] text-right">{row.exceptions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Workforce Intelligence</h2>
            <p className="text-[14px] text-[var(--text-muted)] mt-1">Skill forecasting and process readiness across cohorts.</p>
          </div>
          <div className="bg-[var(--status-info-bg)] text-[var(--primary)] px-3 py-1.5 rounded-md text-[12px] font-bold uppercase tracking-wider flex items-center gap-2 self-start md:self-auto group relative cursor-help border border-[rgba(76,66,238,0.2)]">
            <ShieldAlert className="w-3.5 h-3.5" /> Privacy Protected
            
            <div className="absolute bottom-full right-0 mb-2 w-64 p-3 bg-[var(--text-primary)] text-white text-[12px] rounded-[var(--radius-md)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all shadow-xl pointer-events-none z-10 font-medium normal-case tracking-normal text-left">
              Small cohorts are suppressed to protect individual-level privacy.
              <div className="mt-2 pt-2 border-t border-[rgba(255,255,255,0.2)] text-[11px] text-[rgba(255,255,255,0.7)] font-mono">
                Minimum cohort size: {analytics?.suppressionThreshold || 3}
              </div>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex flex-col">
            <div className="mb-6">
              <h3 className="text-[16px] font-semibold text-[var(--text-primary)] m-0">Skill Inflow Forecast</h3>
              <p className="text-[13px] text-[var(--text-muted)] mt-1">Projected workforce capability demand over the next 30 days.</p>
            </div>
            
            <div className="h-[280px] w-full mt-auto">
              {analytics?.skillInflow ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.skillInflow} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
                    <XAxis dataKey="skill" tick={{fontSize: 12, fill: 'var(--text-muted)', fontWeight: 600}} axisLine={false} tickLine={false} dy={10} />
                    <YAxis tick={{fontSize: 12, fill: 'var(--text-muted)', fontWeight: 600}} axisLine={false} tickLine={false} dx={-10} />
                    <Tooltip 
                      cursor={{fill: 'var(--surface-soft)'}} 
                      contentStyle={{borderRadius: 'var(--radius-md)', fontSize: '13px', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 500}} 
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                      {analytics.skillInflow.map((entry: any, index: number) => (
                        <Cell key={`cell-${index}`} fill={entry.suppressed ? 'var(--lavender)' : 'var(--primary)'} opacity={1} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[13px] text-[var(--text-muted)] font-medium">No forecast data</div>
              )}
            </div>
            <div className="text-[12px] font-medium text-[var(--text-muted)] text-center mt-5">
              Suppressed categories (lavender) meet privacy-protection thresholds and are excluded from individual reporting.
            </div>
          </div>
          
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-sm)] flex flex-col">
            <div className="mb-6">
              <h3 className="text-[16px] font-semibold text-[var(--text-primary)] m-0">Process Readiness</h3>
              <p className="text-[13px] text-[var(--text-muted)] mt-1">Overall readiness of active HR operations processes.</p>
            </div>
            
            <div className="space-y-6 mt-auto mb-auto">
              {analytics?.cohortReadiness ? (() => {
                const readinessKeyMap: Record<string, string> = {
                  'day1-ready': 'Day 1 Ready',
                  'in-progress': 'In Progress',
                  'exception': 'At Risk / Exception'
                };
                
                const total = analytics.cohortReadiness.reduce((sum: number, b: any) => sum + b.count, 0) || 1;
                return analytics.cohortReadiness.map((b: any) => {
                  const percentage = Math.round((b.count / total) * 100);
                  const label = readinessKeyMap[b.key] || b.key.replace(/-/g, ' ');
                  const isRisk = b.key === 'exception';
                  
                  return (
                    <div key={b.key}>
                      <div className="flex justify-between mb-2.5">
                        <span className="text-[14px] text-[var(--text-secondary)] font-semibold capitalize">{label}</span>
                        <span className="text-[14px] text-[var(--text-primary)] font-bold">{percentage}% <span className="text-[var(--text-muted)] font-medium">({b.count})</span></span>
                      </div>
                      <div className="h-2.5 w-full bg-[var(--surface-soft)] rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500 ease-out" 
                             style={{ 
                               width: `${percentage}%`, 
                               backgroundColor: isRisk ? 'var(--status-amber)' : 'var(--primary)' 
                             }} />
                      </div>
                    </div>
                  );
                });
              })() : <div className="text-[13px] text-[var(--text-muted)] font-medium">No readiness data</div>}
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string, value: string, onChange: (v: string) => void, options: {l: string, v: string}[] }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[140px]">
      <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] pl-1">{label}</label>
      <div className="relative">
        <select 
          value={value} 
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none w-full h-[34px] bg-[var(--surface-alt)] hover:bg-[var(--surface-soft)] transition-colors border border-[var(--border)] rounded-[var(--radius-md)] pl-3 pr-8 text-[13px] font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] cursor-pointer"
        >
          {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />
      </div>
    </div>
  );
}

function OpMetric({ label, value, sub }: { label: string, value: React.ReactNode, sub: string }) {
  return (
    <div className="flex flex-col border-l-2 border-[var(--primary)] pl-4 py-1">
      <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">{label}</span>
      <span className="text-[34px] md:text-[38px] font-bold leading-none text-[var(--text-primary)] tracking-tight mt-2 mb-1">{value}</span>
      <span className="text-[13px] text-[var(--text-muted)] font-medium">{sub}</span>
    </div>
  );
}

function RiskCard({ title, value, icon: Icon, color, bg, link }: { title: string, value: number, icon: any, color: string, bg: string, link: string }) {
  return (
    <Link href={link} className="block group h-full">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)] hover:border-[var(--border-strong)] transition-all flex flex-col h-full">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-1.5 rounded-md flex items-center justify-center shrink-0" style={{ color, backgroundColor: bg }}>
            <Icon className="w-4 h-4" />
          </div>
          <span className="text-[13px] font-semibold text-[var(--text-secondary)] group-hover:text-[var(--primary)] transition-colors leading-tight">{title}</span>
        </div>
        <div className="text-[32px] font-bold text-[var(--text-primary)] mt-auto leading-none">{value}</div>
      </div>
    </Link>
  );
}
