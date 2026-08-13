import React from 'react';
import { useGetOnboardingDashboard, useListOnboardingScenarios, useRunOnboardingScenario, getGetOnboardingDashboardQueryKey, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, PageHeader, cn } from '@/components/ui-shared';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Play, AlertCircle, Clock, CheckCircle2, AlertTriangle, Users, Activity } from 'lucide-react';
import { EngineBadge } from '@/components/engine-badge';
import { format } from 'date-fns';

export function DashboardPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: dashboard, isLoading: isLoadingDash } = useGetOnboardingDashboard();
  const { data: scenarios, isLoading: isLoadingScenarios } = useListOnboardingScenarios();
  const runScenario = useRunOnboardingScenario();

  const handleRun = (key: string) => {
    runScenario.mutate({ key }, {
      onSuccess: (caseData) => {
        queryClient.invalidateQueries({ queryKey: getGetOnboardingDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        setLocation(`/cases/${caseData.id}`);
      }
    });
  };

  if (isLoadingDash || isLoadingScenarios) return <div className="p-8 text-center text-[var(--text-muted)]">Loading dashboard...</div>;
  if (!dashboard) return null;

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Control Tower Overview" 
        subtitle="Real-time status of agentic onboarding operations." 
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard title="Total Cases" value={dashboard.totalCases} icon={Users} color="var(--primary)" bg="bg-[var(--surface-soft)]" />
        <KpiCard title="Pending Approvals" value={dashboard.pendingApprovals} icon={Clock} color="var(--status-amber)" bg="bg-[var(--surface-soft)]" />
        <KpiCard title="Hard Blocked" value={dashboard.hardBlocked} icon={AlertCircle} color="var(--status-red)" bg="bg-[var(--surface-soft)]" />
        <KpiCard title="Day-1 at Risk" value={dashboard.day1AtRisk} icon={AlertTriangle} color="var(--status-amber)" bg="bg-[var(--surface-soft)]" />
        <KpiCard title="Ready for Day 1" value={dashboard.readyCases} icon={CheckCircle2} color="var(--status-green)" bg="bg-[var(--surface-soft)]" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-2">
        <Card className="lg:col-span-2 overflow-hidden flex flex-col p-0 shadow-sm border-[var(--border-strong)]">
          <div style={{ padding: 'var(--space-lg)', borderBottom: '1px solid var(--border)' }} className="bg-[var(--surface-alt)] flex items-center justify-between">
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[var(--primary)]" /> Recent Agent Activity
            </h3>
          </div>
          <div className="flex-1 flex flex-col">
            {dashboard.recentEvents?.map((event, i) => (
              <div 
                key={event.id} 
                className="flex items-start transition-colors group"
                style={{ 
                  padding: 'var(--space-md) var(--space-lg)', 
                  borderBottom: i < dashboard.recentEvents!.length - 1 ? '1px solid var(--border)' : 'none',
                  backgroundColor: 'var(--surface)'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--surface-alt)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--surface)'}
              >
                <div className="shrink-0 mt-0.5">
                  <EngineBadge engine={event.engine} />
                </div>
                <div className="min-w-0 flex-1 ml-3">
                  <div className="flex items-start justify-between gap-2">
                    <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="truncate group-hover:text-[var(--primary)] transition-colors">
                      {event.title}
                    </p>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} className="whitespace-nowrap shrink-0 font-medium">
                      {format(new Date(event.createdAt), 'HH:mm:ss')}
                    </span>
                  </div>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: 1.5 }} className="line-clamp-2">
                    {event.detail}
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <span style={{ fontSize: '10px', backgroundColor: 'var(--surface-alt)', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {event.agent}
                    </span>
                    {event.ruleRef && (
                      <span style={{ fontSize: '10px', backgroundColor: 'var(--surface-alt)', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {event.ruleRef}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {!dashboard.recentEvents?.length && (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: 'var(--space-xl)', textAlign: 'center' }}>No recent activity</p>
            )}
          </div>
        </Card>

        <Card className="shadow-sm">
          <div style={{ padding: 'var(--space-lg)', borderBottom: '1px solid var(--border)' }} className="bg-[var(--surface-alt)]">
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="flex items-center gap-2">
              <Play className="w-4 h-4 text-[var(--primary)]" /> Demo Scenarios
            </h3>
          </div>
          <CardContent className="space-y-4 pt-4">
            {scenarios?.map(s => (
              <div key={s.key} className="p-4 rounded-[var(--radius-md)] border-[var(--border)] border bg-[var(--surface)] shadow-sm hover:border-[var(--primary)] hover:shadow-md transition-all group flex flex-col gap-3">
                <div>
                  <h4 className="font-semibold text-[var(--text-sm)] group-hover:text-[var(--primary)] transition-colors">{s.title}</h4>
                  <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1.5 leading-relaxed">{s.description}</p>
                </div>
                <div className="bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-sm)] p-2.5 text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] flex flex-col gap-1">
                  <span className="text-[var(--primary)] opacity-80">Expected Behaviour</span>
                  <span className="normal-case tracking-normal font-medium text-[var(--text-xs)]">{s.expectedBehaviour}</span>
                </div>
                <Button size="sm" onClick={() => handleRun(s.key)} disabled={runScenario.isPending} className="w-full gap-2 font-bold shadow-none mt-1">
                  <Play className="h-3.5 w-3.5" />
                  Run Scenario
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({ title, value, icon: Icon, color, bg }: any) {
  return (
    <Card 
      style={{ padding: 'var(--space-lg)', height: '96px', transition: 'all 150ms ease' }} 
      className={cn("flex flex-col justify-between group hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)] relative overflow-hidden border-transparent", bg)}
    >
      <div className="absolute top-0 right-0 p-4 opacity-[0.05] group-hover:opacity-[0.1] transition-opacity">
        <Icon style={{ width: '48px', height: '48px', color }} />
      </div>
      <div className="flex items-center gap-2 relative z-10">
        <Icon style={{ width: '18px', height: '18px', color }} />
        <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', fontWeight: 700 }}>{title}</span>
      </div>
      <div className="flex items-end justify-between relative z-10">
        <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1, letterSpacing: '-0.02em' }}>{value}</span>
      </div>
    </Card>
  );
}
