import React, { useState } from 'react';
import { useGetOnboardingDemoController, useCreateOnboardingDemoRun, getGetOnboardingDemoControllerQueryKey } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { PageHeader, Card, Button, Label, Input } from '@/components/ui-shared';
import { Presentation, ShieldAlert, Play, Clock, AlertTriangle, ArrowRight } from 'lucide-react';
import type { DemoControllerCapabilities, DemoControllerVolunteer } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { DemoControllerAccessSetup } from './access-setup';

export function DemoControllerIndexPage() {
  const { data: caps, isLoading, isError, refetch } = useGetOnboardingDemoController({
    query: { queryKey: getGetOnboardingDemoControllerQueryKey() }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
        Loading demo capabilities...
      </div>
    );
  }

  if (isError || !caps) {
    return (
      <div className="flex flex-col items-center justify-center p-12 gap-4">
        <AlertTriangle className="h-8 w-8 text-[var(--status-amber)]" />
        <p className="text-sm font-medium">Failed to load demo controller configuration.</p>
        <Button variant="outline" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  if (!caps.available) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 pt-8">
        <Card className="p-8 text-center space-y-4">
          <ShieldAlert className="h-12 w-12 mx-auto text-[var(--status-red)]" />
          <h2 className="text-xl font-bold">Demo Controller access required</h2>
          <p className="text-[var(--text-secondary)]">
            {caps.reason || 'Sign in and select Demo Organization to use Demo Center and its demo overrides.'}
          </p>
          <div className="pt-4">
            <Link href="/">
              <Button>Return to Control Tower</Button>
            </Link>
          </div>
        </Card>
        <DemoControllerAccessSetup />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader 
        title="Demo Center" 
        subtitle="Available to every Demo Organization user. Run synthetic workflows and use demo overrides for presentation and training."
      />
      <DemoControllerAccessSetup />
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <NewRunForm caps={caps} />
        </div>
        <div className="lg:col-span-2 space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)]">Existing Demo Sessions</h3>
          {caps.existingSessions.length === 0 ? (
            <Card className="p-12 text-center text-[var(--text-muted)] text-sm flex flex-col items-center justify-center bg-[var(--surface-alt)] border-dashed">
              <Presentation className="h-8 w-8 mb-3 opacity-20" />
              No active demo runs found.
            </Card>
          ) : (
            <div className="grid gap-3">
              {caps.existingSessions.map(session => (
                <Link key={session.runId} href={`/demo-controller/${session.runId}`}>
                  <Card className="p-4 flex items-center justify-between hover:bg-[var(--surface-soft)] transition-colors cursor-pointer border-[var(--border)] group shadow-sm hover:shadow-md">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{session.caseName || 'Demo Case'}</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--surface-alt)] text-[var(--text-secondary)] border border-[var(--border)]">
                          {session.scenario}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
                        <span className="flex items-center gap-1 font-mono"><Clock className="w-3 h-3" /> {format(new Date(session.updatedAt), 'MMM d, h:mm a')}</span>
                        <span className="flex items-center gap-1">Status: <strong className="text-[var(--text-primary)] uppercase text-[10px]">{session.status}</strong></span>
                      </div>
                    </div>
                    <ArrowRight className="w-5 h-5 text-[var(--text-muted)] group-hover:text-[var(--primary)] transition-colors" />
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewRunForm({ caps }: { caps: DemoControllerCapabilities }) {
  const [, setLocation] = useLocation();
  const createRun = useCreateOnboardingDemoRun();
  const [scenario, setScenario] = useState(caps.scenarios[0]?.key || '');
  const [volunteerId, setVolunteerId] = useState('');
  const [error, setError] = useState<string|null>(null);

  const volunteers = caps.approvedVolunteers;

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scenario) return;
    setError(null);
    try {
      const run = await createRun.mutateAsync({
        data: {
          scenario,
          volunteerId: volunteerId || null,
          mode: 'hybrid'
        }
      });
      setLocation(`/demo-controller/${run.runId}`);
    } catch (err: any) {
      setError(err?.response?.data?.message || err.message || 'Failed to start demo run');
    }
  };

  return (
    <Card className="p-5 space-y-5 border-[var(--primary-light)] bg-gradient-to-b from-[var(--surface)] to-[var(--surface-alt)]">
      <div>
        <h3 className="font-semibold flex items-center gap-2 text-[var(--primary-dark)]">
          <Play className="w-4 h-4" /> Start Fresh Demo
        </h3>
        <p className="text-xs text-[var(--text-muted)] mt-1">Create a sandboxed synthetic case for walkthroughs.</p>
      </div>

      {error && (
        <div className="p-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-xs rounded-md border border-[var(--status-red)]">
          {error}
        </div>
      )}

      <form onSubmit={handleStart} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Scenario</Label>
          <select 
            value={scenario}
            onChange={e => setScenario(e.target.value)}
            className="flex h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          >
            {caps.scenarios.map((s: any) => (
              <option key={s.key} value={s.key}>{s.title}</option>
            ))}
          </select>
          <div className="text-[11px] text-[var(--text-muted)] leading-tight mt-1">
            {caps.scenarios.find((s: any) => s.key === scenario)?.description}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Volunteer (Optional)</Label>
          <select 
            value={volunteerId}
            onChange={e => setVolunteerId(e.target.value)}
            className="flex h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          >
            <option value="">None (Fully Simulated)</option>
            {volunteers.map(v => (
              <option key={v.id} value={v.id} disabled={!v.approved}>
                {v.name} ({v.email}) {!v.approved ? '- Pending Approval' : ''}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-[var(--text-muted)] leading-tight mt-1">
            Volunteers receive real emails/calls during explicit LIVE actions. Add volunteers in Settings.
          </div>
        </div>

        <Button type="submit" className="w-full gap-2 mt-2" disabled={createRun.isPending || !caps.canCreateRuns}>
          {createRun.isPending ? 'Starting...' : 'Start Walkthrough'}
        </Button>
      </form>
    </Card>
  );
}
