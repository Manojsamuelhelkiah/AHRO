import React from 'react';
import { useGetOnboardingAnalytics } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Badge, PageHeader, IconTile, LoadingBlock, cn } from '@/components/ui-shared';
import { BrainCircuit, ShieldAlert, TrendingUp, AlertTriangle, Workflow, Users, Activity } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';

export function AnalyticsPage() {
  const { data: analytics, isLoading } = useGetOnboardingAnalytics();

  if (isLoading) return <LoadingBlock className="mx-auto max-w-2xl mt-8">Generating analytics...</LoadingBlock>;
  if (!analytics) return null;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <PageHeader 
        title="Data & Analytics Agent" 
        subtitle="Pattern detection and predictive readiness insights for onboarding cohorts." 
      />

      <div className="bg-[var(--status-info-bg)] rounded-[var(--radius-lg)] p-[var(--space-lg)] flex flex-col md:flex-row gap-4 items-start shadow-[var(--shadow-sm)]">
        <IconTile icon={BrainCircuit} className="bg-[var(--surface)] text-[var(--primary)] border-none shadow-[var(--shadow-sm)]" />
        <div className="space-y-1.5">
          <h3 className="font-bold tracking-wide text-[var(--text-sm)] uppercase text-[var(--primary)]">Agent Narrative Insight</h3>
          <p className="text-[var(--text-primary)] leading-relaxed text-[var(--text-base)] font-medium">
            {analytics.narrative}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <Card className="border-none shadow-[var(--shadow-md)] bg-[var(--surface)] overflow-hidden flex flex-col">
          <CardHeader className="pb-4 bg-[var(--surface-alt)] border-b border-[var(--border)]">
            <div className="flex justify-between items-start gap-4">
              <div>
                <CardTitle className="text-[var(--text-lg)] text-[var(--text-primary)] flex items-center gap-2">
                  <Activity className="w-5 h-5 text-[var(--primary)]" />
                  Skill Inflow Forecast
                </CardTitle>
                <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">Next 30 days based on active cases</p>
              </div>
              <Badge className="gap-1.5 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-none shadow-none shrink-0 text-[var(--text-xs)] font-bold">
                <ShieldAlert className="w-4 h-4" /> Privacy Guard Active
              </Badge>
            </div>
            <p className="text-[var(--text-xs)] uppercase tracking-wider font-bold text-[var(--primary)] mt-4 bg-[var(--status-info-bg)] p-2.5 rounded-[var(--radius-md)] inline-block">
              Privacy threshold is set to K={analytics.suppressionThreshold}
            </p>
          </CardHeader>
          <CardContent className="pt-6 flex-1 flex flex-col">
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.skillInflow} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.5} />
                  <XAxis dataKey="skill" tick={{fontSize: 12, fill: 'var(--text-muted)', fontWeight: 600}} axisLine={false} tickLine={false} dy={10} />
                  <YAxis tick={{fontSize: 12, fill: 'var(--text-muted)', fontWeight: 600}} axisLine={false} tickLine={false} dx={-10} />
                  <Tooltip 
                    cursor={{fill: 'var(--surface-soft)'}} 
                    contentStyle={{borderRadius: 'var(--radius-md)', fontSize: '13px', border: 'none', boxShadow: 'var(--shadow-md)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 500}} 
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {analytics.skillInflow.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.suppressed ? 'var(--border-strong)' : 'var(--primary)'} opacity={1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-6 text-[var(--text-xs)] text-[var(--text-muted)] text-center font-semibold">
              Greyed bars indicate categories suppressed below K-anonymity threshold.
            </div>
          </CardContent>
        </Card>

        <div className="space-y-8">
          <Card className="border-none shadow-[var(--shadow-md)] bg-[var(--surface)]">
            <CardHeader className="pb-4 bg-[var(--surface-alt)] border-b border-[var(--border)]">
              <CardTitle className="flex items-center gap-2 text-[var(--text-lg)] text-[var(--text-primary)]">
                <Users className="w-5 h-5 text-[var(--status-green-fg)]" /> 
                Cohort Readiness
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-5">
                {(() => {
                  const total = analytics.cohortReadiness.reduce((sum: number, b: any) => sum + b.count, 0) || 1;
                  return analytics.cohortReadiness.map((b: any) => {
                    const percentage = Math.round((b.count / total) * 100);
                    return (
                      <div key={b.key}>
                        <div className="flex justify-between text-[var(--text-sm)] mb-2 font-semibold">
                          <span className="text-[var(--text-secondary)] capitalize tracking-wide">{b.key.replace(/-/g, ' ')}</span>
                          <span className="text-[var(--primary)] font-bold">{percentage}% <span className="text-[var(--text-muted)] font-medium">({b.count})</span></span>
                        </div>
                        <div className="h-2.5 w-full bg-[var(--surface-soft)] rounded-full overflow-hidden">
                          <div className="h-full bg-[var(--primary)] transition-all duration-500 ease-out" style={{ width: `${percentage}%` }} />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-[var(--shadow-md)] bg-[var(--surface)]">
            <CardHeader className="pb-4 bg-[var(--surface-alt)] border-b border-[var(--border)]">
              <CardTitle className="flex items-center gap-2 text-[var(--text-lg)] text-[var(--text-primary)]">
                <Workflow className="w-5 h-5 text-[var(--status-amber-fg)]" /> 
                Bottleneck Themes
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <ul className="space-y-4">
                {analytics.bottlenecks.map((b: any, i: number) => (
                  <li key={i} className="flex gap-4 items-start text-[var(--text-sm)] bg-[var(--surface-soft)] p-[var(--space-md)] rounded-[var(--radius-md)]">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] font-bold shrink-0 text-[var(--text-xs)] shadow-sm">
                      {b.occurrences}
                    </span>
                    <div>
                      <span className="text-[var(--text-primary)] font-bold capitalize text-[var(--text-sm)] tracking-wide">{b.theme.replace(/-/g, ' ')}</span>
                      <p className="text-[var(--text-secondary)] text-[var(--text-sm)] mt-1 font-medium leading-relaxed">{b.note}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
