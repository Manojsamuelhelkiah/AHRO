import React, { useState } from 'react';
import { useGetOnboardingDemoController, useCreateOnboardingDemoRun, getGetOnboardingDemoControllerQueryKey } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { PageHeader, Card, Button, Label, Input } from '@/components/ui-shared';
import { Presentation, ShieldAlert, Play, Clock, AlertTriangle, ArrowRight, CheckCircle2, UserRound, ShieldCheck } from 'lucide-react';
import type { DemoControllerCapabilities, DemoControllerVolunteer } from '@workspace/api-client-react';
import { format } from 'date-fns';
import { DemoControllerAccessSetup } from './access-setup';

export const DEMO_CAPABILITIES_REFRESH_INTERVAL_MS = 30_000;

export function DemoControllerIndexPage() {
  const { data: caps, isLoading, isError, refetch } = useGetOnboardingDemoController({
    query: {
      queryKey: getGetOnboardingDemoControllerQueryKey(),
      refetchInterval: DEMO_CAPABILITIES_REFRESH_INTERVAL_MS,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
    }
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
      <DemoPrivacyReadinessPanel caps={caps} />
      
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

function DemoPrivacyReadinessPanel({ caps }: { caps: DemoControllerCapabilities }) {
  const volunteers = caps.approvedVolunteers;
  const statusLabel = (status: DemoControllerVolunteer["privacyReadiness"]["authorityStatus"]) => ({
    verified: "Verified reviewer",
    nominated: "Nominated — verification pending",
    revoked: "Previous reviewer revoked",
    expired: "Previous reviewer expired",
    missing: "No verified reviewer",
  }[status]);

  return (
    <Card className="p-5 space-y-5 border-[var(--primary-light)] bg-[var(--surface)]" aria-labelledby="demo-privacy-readiness">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <h2 id="demo-privacy-readiness" className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--primary)]" /> Privacy readiness for live volunteers
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-1 max-w-3xl">
            Fully simulated walkthroughs are always available and use fictional data only. A volunteer-backed walkthrough
            retains real contact/profile information and stays blocked until the server confirms the complete policy envelope.
          </p>
        </div>
        <Link href="/settings#sensitive-lifecycle-policies">
          <Button variant="outline" size="sm">Open lifecycle policies</Button>
        </Link>
      </div>

      {volunteers.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-muted)]">
          No volunteer is configured. Choose <strong>None (Fully Simulated)</strong> below for a synthetic walkthrough.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {volunteers.map((volunteer) => {
            const privacy = volunteer.privacyReadiness;
            const ready = volunteer.lifecyclePolicyReady && volunteer.approved;
            const actionHref = privacy.nextAction === "nominate-reviewer" || privacy.nextAction === "wait-for-verification"
              ? "/policy-review#authority-assignments"
              : "/settings#sensitive-lifecycle-policies";
            return (
              <div key={volunteer.id} className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <UserRound className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
                      <h3 className="font-semibold text-sm truncate">{volunteer.name}</h3>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] mt-1">
                      Work country: <strong className="text-[var(--text-secondary)]">{volunteer.workCountry || "Not set"}</strong>
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                    ready ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]"
                  }`}>
                    {ready ? "Ready" : "Blocked"}
                  </span>
                </div>

                <div className="space-y-1 text-[11px]">
                  <p className="font-medium text-[var(--text-secondary)]">{statusLabel(privacy.authorityStatus)}</p>
                  {privacy.reviewer ? (
                    <p className="text-[var(--text-muted)]">
                      Approver: <strong className="text-[var(--text-primary)]">{privacy.reviewer.memberDisplay}</strong> ({privacy.reviewer.role})
                    </p>
                  ) : privacy.nomination ? (
                    <p className="text-[var(--status-amber-fg)]">
                      Nominee: <strong>{privacy.nomination.memberDisplay}</strong>. A server-verified operator must confirm this nomination.
                    </p>
                  ) : (
                    <p className="text-[var(--text-muted)]">
                      Owner/admin membership, a demo persona, or a mailbox address does not create specialist authority.
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    Policy coverage
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {privacy.requiredPolicyCoverage.map((dataClass) => {
                      const covered = privacy.coveredPolicyCoverage.includes(dataClass);
                      return (
                        <span key={dataClass} className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          covered
                            ? "border-[var(--status-green)]/30 bg-[var(--status-green-bg)] text-[var(--status-green-fg)]"
                            : "border-[var(--status-amber)]/40 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]"
                        }`}>
                          {covered ? "✓ " : ""}{dataClass}
                        </span>
                      );
                    })}
                  </div>
                  {privacy.missingPolicyCoverage.length > 0 && (
                    <p className="text-[11px] text-[var(--status-amber-fg)] mt-2">
                      Missing: {privacy.missingPolicyCoverage.join(", ")}
                    </p>
                  )}
                </div>

                {!ready && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                    <p className="text-[11px] text-[var(--text-muted)]">
                      {volunteer.lifecyclePolicyReason || "Current volunteer approval and policy coverage are required."}
                    </p>
                    <Link href={actionHref}>
                      <Button size="sm" variant="outline">
                        {privacy.nextAction === "nominate-reviewer" ? "Nominate reviewer"
                          : privacy.nextAction === "wait-for-verification" ? "View verification"
                            : "Review policy pack"}
                      </Button>
                    </Link>
                  </div>
                )}
                {ready && privacy.reviewer && (
                  <div className="flex items-center gap-2 text-[11px] text-[var(--status-green-fg)] border-t border-[var(--border)] pt-3">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Verified reviewer can approve or revise policies in Settings.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function NewRunForm({ caps }: { caps: DemoControllerCapabilities }) {
  const [, setLocation] = useLocation();
  const createRun = useCreateOnboardingDemoRun();
  const [scenario, setScenario] = useState(caps.scenarios[0]?.key || '');
  const [volunteerId, setVolunteerId] = useState('');
  const [error, setError] = useState<string|null>(null);

  const volunteers = caps.approvedVolunteers;
  const selectedVolunteer = volunteers.find(v => v.id === volunteerId);
  const selectedVolunteerUnavailable = selectedVolunteer
    ? !selectedVolunteer.approved || !selectedVolunteer.lifecyclePolicyReady
    : false;

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
              <option key={v.id} value={v.id} disabled={!v.approved || !v.lifecyclePolicyReady}>
                {v.name} ({v.email}) {!v.approved
                  ? '- Volunteer approval required'
                  : !v.lifecyclePolicyReady
                    ? `- Privacy approval required${v.workCountry ? ` for ${v.workCountry}` : ''}`
                    : ''}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-[var(--text-muted)] leading-tight mt-1">
            Volunteers receive real emails/calls during explicit LIVE actions. Add volunteers in Settings.
          </div>
          {volunteers.some(v => !v.approved || !v.lifecyclePolicyReady) && (
            <div className="space-y-1 pt-1">
              {volunteers.filter(v => !v.approved || !v.lifecyclePolicyReady).map(v => (
                <p key={v.id} className="text-[11px] text-[var(--status-amber-fg)] leading-tight">
                  <strong>{v.name}:</strong>{' '}
                  {!v.approved
                    ? v.capabilityReason || 'This volunteer still needs approval.'
                    : v.lifecyclePolicyReason || 'Current privacy approval is required before this volunteer can be used.'}
                </p>
              ))}
            </div>
          )}
        </div>

        <Button type="submit" className="w-full gap-2 mt-2" disabled={createRun.isPending || !caps.canCreateRuns || selectedVolunteerUnavailable}>
          {createRun.isPending ? 'Starting...' : 'Start Walkthrough'}
        </Button>
        <p className="text-[11px] text-[var(--text-muted)] leading-tight text-center">
          You can always start a fully simulated walkthrough by choosing “None (Fully Simulated)”; it does not use a real volunteer.
        </p>
      </form>
    </Card>
  );
}
