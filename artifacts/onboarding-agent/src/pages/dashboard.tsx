import React from 'react';
import { useGetOnboardingDashboard, useListOnboardingScenarios, useRunOnboardingScenario, getGetOnboardingDashboardQueryKey, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, PageHeader, cn } from '@/components/ui-shared';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Play, AlertCircle, Clock, CheckCircle2, AlertTriangle, Users } from 'lucide-react';
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
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader 
        title="Control Tower Overview" 
        subtitle="Real-time status of agentic onboarding operations." 
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard title="Total Cases" value={dashboard.totalCases} icon={Users} color="var(--primary)" />
        <KpiCard title="Pending Approvals" value={dashboard.pendingApprovals} icon={Clock} color="var(--status-amber)" />
        <KpiCard title="Hard Blocked" value={dashboard.hardBlocked} icon={AlertCircle} color="var(--status-red)" />
        <KpiCard title="Day-1 at Risk" value={dashboard.day1AtRisk} icon={AlertTriangle} color="var(--status-amber)" />
        <KpiCard title="Ready for Day 1" value={dashboard.readyCases} icon={CheckCircle2} color="var(--status-green)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-2">
        <Card className="lg:col-span-2 overflow-hidden flex flex-col p-0">
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>Recent Agent Activity</h3>
          </div>
          <div className="flex-1 flex flex-col">
            {dashboard.recentEvents?.map((event, i) => (
              <div 
                key={event.id} 
                className="flex items-start transition-colors"
                style={{ 
                  padding: '14px 20px', 
                  borderBottom: i < dashboard.recentEvents!.length - 1 ? '1px solid var(--border)' : 'none',
                  backgroundColor: 'var(--surface)'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = '#fafafa'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--surface)'}
              >
                <div className="shrink-0 mt-0.5">
                  <EngineBadge engine={event.engine} />
                </div>
                <div className="min-w-0 flex-1 ml-3">
                  <div className="flex items-start justify-between gap-2">
                    <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">
                      {event.title}
                    </p>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} className="whitespace-nowrap shrink-0">
                      {format(new Date(event.createdAt), 'HH:mm:ss')}
                    </span>
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }} className="line-clamp-2">
                    {event.detail}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span style={{ fontSize: '11px', backgroundColor: '#f3f4f6', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: '999px' }}>
                      {event.agent}
                    </span>
                    {event.ruleRef && (
                      <span style={{ fontSize: '11px', backgroundColor: '#f3f4f6', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: '999px' }}>
                        {event.ruleRef}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {!dashboard.recentEvents?.length && (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '20px', textAlign: 'center' }}>No recent activity</p>
            )}
          </div>
        </Card>

        <Card>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>Demo Scenarios</h3>
          </div>
          <CardContent className="space-y-4 pt-4">
            {scenarios?.map(s => (
              <div key={s.key} className="p-4 rounded-lg border bg-[var(--surface-alt)] flex flex-col gap-3">
                <div>
                  <h4 className="font-semibold text-[13px]">{s.title}</h4>
                  <p className="text-[12px] text-[var(--text-secondary)] mt-1">{s.description}</p>
                </div>
                <div className="bg-white border rounded p-2 text-[11px] font-mono text-[var(--text-muted)]">
                  Expected: {s.expectedBehaviour}
                </div>
                <Button size="sm" onClick={() => handleRun(s.key)} disabled={runScenario.isPending} className="w-full gap-2">
                  <Play className="h-3 w-3" />
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

function KpiCard({ title, value, icon: Icon, color }: any) {
  return (
    <Card 
      style={{ padding: '20px 24px', height: '96px', transition: 'all 150ms ease' }} 
      className="flex flex-col justify-between group hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)]"
    >
      <div className="flex items-center gap-2">
        <Icon style={{ width: '24px', height: '24px', color }} />
        <span style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>{title}</span>
      </div>
      <div className="flex items-end justify-between">
        <span style={{ fontSize: '32px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
      </div>
    </Card>
  );
}
