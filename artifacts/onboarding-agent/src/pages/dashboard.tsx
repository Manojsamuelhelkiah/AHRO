import React from 'react';
import { useGetOnboardingDashboard, useListOnboardingScenarios, useRunOnboardingScenario, getGetOnboardingDashboardQueryKey, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, cn } from '@/components/ui-shared';
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

  if (isLoadingDash || isLoadingScenarios) return <div className="p-8 text-center text-muted-foreground">Loading dashboard...</div>;
  if (!dashboard) return null;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Control Tower Overview</h1>
        <p className="text-muted-foreground mt-1">Real-time status of agentic onboarding operations.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard title="Total Cases" value={dashboard.totalCases} icon={Users} color="text-blue-600" bg="bg-blue-100" />
        <KpiCard title="Pending Approvals" value={dashboard.pendingApprovals} icon={Clock} color="text-amber-600" bg="bg-amber-100" />
        <KpiCard title="Hard Blocked" value={dashboard.hardBlocked} icon={AlertCircle} color="text-red-600" bg="bg-red-100" />
        <KpiCard title="Day-1 at Risk" value={dashboard.day1AtRisk} icon={AlertTriangle} color="text-orange-600" bg="bg-orange-100" />
        <KpiCard title="Ready for Day 1" value={dashboard.readyCases} icon={CheckCircle2} color="text-emerald-600" bg="bg-emerald-100" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent Agent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {dashboard.recentEvents?.map((event) => (
                <div key={event.id} className="flex gap-4 p-3 rounded-lg border border-border/50 bg-secondary/30">
                  <div className="shrink-0 mt-1">
                    <EngineBadge engine={event.engine} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">{event.title}</p>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(event.createdAt), 'HH:mm:ss')}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{event.detail}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{event.agent}</span>
                      {event.ruleRef && <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{event.ruleRef}</span>}
                    </div>
                  </div>
                </div>
              ))}
              {!dashboard.recentEvents?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">No recent activity</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Demo Scenarios</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {scenarios?.map(s => (
              <div key={s.key} className="p-4 rounded-lg border bg-card flex flex-col gap-3">
                <div>
                  <h4 className="font-semibold text-sm">{s.title}</h4>
                  <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                </div>
                <div className="bg-secondary/50 rounded p-2 text-xs font-mono text-muted-foreground">
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

function KpiCard({ title, value, icon: Icon, color, bg }: any) {
  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-4">
        <div className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0", bg, color)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}