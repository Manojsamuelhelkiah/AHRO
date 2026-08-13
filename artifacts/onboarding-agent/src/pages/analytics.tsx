import React from 'react';
import { useGetOnboardingAnalytics, getGetOnboardingAnalyticsQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Badge, PageHeader, IconTile, LoadingBlock, cn } from '@/components/ui-shared';
import { BrainCircuit, ShieldAlert, TrendingUp, AlertTriangle, Workflow, Users, Activity } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';

export function AnalyticsPage() {
  const { data: analytics, isLoading } = useGetOnboardingAnalytics({
    query: {
      queryKey: getGetOnboardingAnalyticsQueryKey(),
      // The AI narrative is generated in the background server-side;
      // poll until it arrives, then stop.
      refetchInterval: (query) => (query.state.data && !query.state.data.narrative ? 4000 : false),
    },
  });

  if (isLoading) return <LoadingBlock className="mx-auto max-w-2xl mt-8">Loading analytics...</LoadingBlock>;
  if (!analytics) return null;

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Data & Analytics Agent" 
        subtitle="Pattern detection and predictive readiness insights for onboarding cohorts." 
      />

      <div style={{ backgroundColor: 'var(--status-info-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-lg)' }} className="flex flex-col md:flex-row gap-4 items-start">
        <IconTile icon={BrainCircuit} className="bg-[var(--surface)] text-[var(--primary)] border-none shadow-[var(--shadow-sm)]" />
        <div className="space-y-1.5">
          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Agent Narrative Insight</h3>
          <p style={{ fontSize: 'var(--text-base)', color: analytics.narrative ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: 500, margin: 0, lineHeight: 1.5 }}>
            {analytics.narrative ?? 'The Data & Analytics Agent is writing this insight — it will appear here in a few seconds.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <div className="flex justify-between items-start">
              <div>
                <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Activity className="w-5 h-5 text-[var(--primary)]" />
                  Skill Inflow Forecast
                </h2>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Next 30 days based on active cases</p>
              </div>
              <span style={{ backgroundColor: 'var(--status-amber-bg)', color: 'var(--status-amber-fg)', fontSize: 'var(--text-xs)', fontWeight: 600, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                <ShieldAlert className="w-3.5 h-3.5" /> Privacy Guard Active
              </span>
            </div>
            <p style={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 700, color: 'var(--primary)', backgroundColor: 'var(--status-info-bg)', padding: '4px 8px', borderRadius: '4px', display: 'inline-block', marginTop: '12px' }}>
              Privacy threshold is set to K={analytics.suppressionThreshold}
            </p>
          </div>

          <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-lg)' }} className="flex flex-col">
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
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'center', marginTop: '24px' }}>
              Greyed bars indicate categories suppressed below K-anonymity threshold.
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-4">
            <div>
              <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Users className="w-5 h-5 text-[var(--status-green-fg)]" /> 
                Cohort Readiness
              </h2>
            </div>
            <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-lg)' }}>
              <div className="space-y-5">
                {(() => {
                  const total = analytics.cohortReadiness.reduce((sum: number, b: any) => sum + b.count, 0) || 1;
                  return analytics.cohortReadiness.map((b: any) => {
                    const percentage = Math.round((b.count / total) * 100);
                    return (
                      <div key={b.key}>
                        <div className="flex justify-between mb-2">
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'capitalize', letterSpacing: '0.02em' }}>{b.key.replace(/-/g, ' ')}</span>
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', fontWeight: 700 }}>{percentage}% <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({b.count})</span></span>
                        </div>
                        <div style={{ height: '10px', width: '100%', backgroundColor: 'var(--surface-soft)', borderRadius: '999px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', backgroundColor: 'var(--primary)', width: `${percentage}%`, transition: 'width 500ms ease-out' }} />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Workflow className="w-5 h-5 text-[var(--status-amber-fg)]" /> 
                Bottleneck Themes
              </h2>
            </div>
            <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-lg)' }}>
              <ul className="space-y-4">
                {analytics.bottlenecks.map((b: any, i: number) => (
                  <li key={i} className="flex gap-4 items-start" style={{ padding: 'var(--space-md)', backgroundColor: 'var(--surface-soft)', borderRadius: 'var(--radius-md)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', borderRadius: '999px', backgroundColor: 'var(--status-amber-bg)', color: 'var(--status-amber-fg)', fontWeight: 700, fontSize: 'var(--text-xs)', flexShrink: 0, boxShadow: 'var(--shadow-sm)' }}>
                      {b.occurrences}
                    </span>
                    <div>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.02em' }}>{b.theme.replace(/-/g, ' ')}</span>
                      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 500, lineHeight: 1.5, marginBottom: 0 }}>{b.note}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
