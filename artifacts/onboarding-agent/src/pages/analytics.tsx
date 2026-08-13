import React from 'react';
import { useGetOnboardingAnalytics } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Badge, PageHeader, IconTile, LoadingBlock } from '@/components/ui-shared';
import { BrainCircuit, ShieldAlert, TrendingUp, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

export function AnalyticsPage() {
  const { data: analytics, isLoading } = useGetOnboardingAnalytics();

  if (isLoading) return <LoadingBlock className="mx-auto max-w-2xl mt-8">Generating analytics...</LoadingBlock>;
  if (!analytics) return null;

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <PageHeader 
        title="Data & Analytics Agent" 
        subtitle="Pattern detection and predictive readiness insights for onboarding cohorts." 
      />

      <Card className="bg-[var(--primary-light)] border-[var(--border-strong)] shadow-sm">
        <CardContent className="p-[var(--space-lg)] flex flex-col md:flex-row gap-3 items-start">
          <IconTile icon={BrainCircuit} className="bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-400 border-indigo-200" />
          <div className="space-y-1">
            <h3 className="font-semibold text-[var(--text-sm)] text-indigo-950 dark:text-indigo-300">Agent Narrative Insight</h3>
            <p className="text-indigo-900 dark:text-indigo-200/80 leading-relaxed text-[var(--text-sm)]">
              {analytics.narrative}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex justify-between items-start gap-4">
              <div>
                <CardTitle className="text-[var(--text-base)]">Skill Inflow Forecast</CardTitle>
                <p className="text-[var(--text-xs)] text-muted-foreground mt-1">Next 30 days based on active cases</p>
              </div>
              <Badge variant="outline" className="gap-1.5 bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                <ShieldAlert className="w-3.5 h-3.5" /> Privacy Guard Active
              </Badge>
            </div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mt-2 bg-muted/40 p-2 rounded border border-dashed">Privacy threshold is set to K={analytics.suppressionThreshold}</p>
          </CardHeader>
          <CardContent>
            <div className="h-[280px] mt-3">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.skillInflow} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="skill" tick={{fontSize: 11, fill: 'hsl(var(--muted-foreground))'}} axisLine={false} tickLine={false} />
                  <YAxis tick={{fontSize: 11, fill: 'hsl(var(--muted-foreground))'}} axisLine={false} tickLine={false} />
                  <Tooltip 
                    cursor={{fill: 'hsl(var(--muted))', opacity: 0.4}} 
                    contentStyle={{borderRadius: '8px', fontSize: '12px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} 
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={50}>
                    {analytics.skillInflow.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.suppressed ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary))'} opacity={entry.suppressed ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 text-[10px] text-muted-foreground text-center font-semibold uppercase tracking-wider">
              Greyed bars indicate categories suppressed below K-anonymity threshold.
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b bg-muted/10">
              <CardTitle className="flex items-center gap-2 text-[var(--text-base)]">
                <TrendingUp className="w-4 h-4 text-emerald-500" /> Cohort Readiness
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="space-y-4">
                {(() => {
                  const total = analytics.cohortReadiness.reduce((sum: number, b: any) => sum + b.count, 0) || 1;
                  return analytics.cohortReadiness.map((b: any) => {
                    const percentage = Math.round((b.count / total) * 100);
                    return (
                      <div key={b.key}>
                        <div className="flex justify-between text-[var(--text-sm)] mb-1.5">
                          <span className="font-semibold text-foreground capitalize">{b.key.replace(/-/g, ' ')}</span>
                          <span className="font-semibold text-primary">{percentage}% ({b.count})</span>
                        </div>
                        <div className="h-2 w-full bg-secondary rounded-full overflow-hidden border">
                          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${percentage}%` }} />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b bg-muted/10">
              <CardTitle className="flex items-center gap-2 text-[var(--text-base)]">
                <AlertTriangle className="w-4 h-4 text-amber-500" /> Bottleneck Themes
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <ul className="space-y-3">
                {analytics.bottlenecks.map((b: any, i: number) => (
                  <li key={i} className="flex gap-3 items-start text-[var(--text-sm)]">
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 font-bold shrink-0 text-[10px]">
                      {b.occurrences}
                    </span>
                    <div>
                      <span className="text-foreground/90 font-semibold capitalize">{b.theme.replace(/-/g, ' ')}</span>
                      <p className="text-muted-foreground text-[var(--text-xs)] mt-1">{b.note}</p>
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