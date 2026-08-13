import React, { useState } from 'react';
import {
  useGetOnboardingGuardrails,
  getGetOnboardingGuardrailsQueryKey,
  useListGuardrailEvents,
  getListGuardrailEventsQueryKey,
  useRunOnboardingSecurityDrill,
  type Guardrail,
  type SecurityDrillResult,
} from '@workspace/api-client-react';
import { Card, Button, Badge, cn, PageHeader, SectionHeading, LoadingBlock } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Link } from 'wouter';
import {
  Shield, ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Swords,
  FlaskConical, MapPin, CircleCheck, Clock, ExternalLink,
} from 'lucide-react';

const SEVERITY_STYLE: Record<string, {bg: string, fg: string}> = {
  critical: { bg: 'var(--status-red-bg)', fg: 'var(--status-red-fg)' },
  high: { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-fg)' },
  medium: { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-fg)' },
  low: { bg: 'var(--status-gray-bg)', fg: 'var(--status-gray-fg)' },
};

const ACTION_STYLE: Record<string, {bg: string, fg: string}> = {
  blocked: { bg: 'var(--status-red-bg)', fg: 'var(--status-red-fg)' },
  rejected: { bg: 'var(--status-red-bg)', fg: 'var(--status-red-fg)' },
  'rate-limited': { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-fg)' },
  sanitized: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)' },
  escalated: { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-fg)' },
};

function CompactBadge({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span style={{ backgroundColor: bg, color: fg, fontSize: 'var(--text-xs)', fontWeight: 600, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export function GuardrailsPage() {
  const { data, isLoading } = useGetOnboardingGuardrails({
    query: { queryKey: getGetOnboardingGuardrailsQueryKey(), refetchInterval: 30_000 },
  });
  const [drillResult, setDrillResult] = useState<SecurityDrillResult | null>(null);
  const drill = useRunOnboardingSecurityDrill();
  const queryClient = useQueryClient();

  const guardrails = data?.guardrails ?? [];
  const totalActivations = guardrails.reduce((s, g) => s + g.activationCount, 0);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Guardrails" 
        subtitle="Every safety control enforced on AI communications — with live evidence of each intervention."
      >
        <Button
          onClick={() =>
            drill.mutate(undefined as never, {
              onSuccess: (res) => {
                setDrillResult(res);
                queryClient.invalidateQueries({ queryKey: getGetOnboardingGuardrailsQueryKey() });
              },
            })
          }
          disabled={drill.isPending}
          className="gap-2"
        >
          <Swords className="w-4 h-4" />
          {drill.isPending ? 'Running attacks…' : 'Run security drill'}
        </Button>
      </PageHeader>

      {drillResult && <DrillResultCard result={drillResult} onDismiss={() => setDrillResult(null)} />}
      {drill.isError && (
        <div style={{ backgroundColor: 'var(--status-red-bg)', color: 'var(--status-red-fg)', padding: 'var(--space-lg)', borderRadius: 'var(--radius-lg)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
          The drill could not be completed. Check the server logs and try again.
        </div>
      )}

      <div style={{ padding: '8px var(--space-lg)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }} className="flex items-center gap-4 flex-wrap text-[var(--text-sm)] mt-2">
        <div className="flex items-center gap-1.5" style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-secondary)' }}>
          <ShieldCheck className="w-4 h-4 text-[var(--status-green-fg)]" /> 
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{guardrails.length}</span> controls enforced
        </div>
        <div className="flex items-center gap-1.5" style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-secondary)' }}>
          <ShieldAlert className="w-4 h-4 text-[var(--status-red-fg)]" /> 
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{totalActivations}</span> recorded interventions
        </div>
      </div>

      {isLoading ? (
        <LoadingBlock>Loading guardrails…</LoadingBlock>
      ) : (
        (data?.categories ?? []).map((cat) => {
          const items = guardrails.filter((g) => g.category === cat.key);
          if (items.length === 0) return null;
          return (
            <section key={cat.key} className="space-y-4 pt-4">
              <div>
                <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{cat.title}</h2>
                {cat.blurb && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>{cat.blurb}</p>}
              </div>
              <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
                {items.map((g) => (
                  <GuardrailCard key={g.key} guardrail={g} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function DrillResultCard({ result, onDismiss }: { result: SecurityDrillResult; onDismiss: () => void }) {
  return (
    <Card className="p-[var(--space-lg)] bg-[var(--surface)] border-none shadow-[var(--shadow-md)] mt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2 text-[var(--text-lg)] text-[var(--text-primary)]">
            <Swords className="w-5 h-5 text-[var(--status-green-fg)]" />
            Security drill complete — {result.steps.length} simulated attacks, all handled
          </h3>
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">
            Each attack ran through the live enforcement code, not a mock. The full story is on the{' '}
            <Link href={`/cases/${result.caseId}`} className="text-[var(--primary)] font-semibold hover:underline inline-flex items-center gap-0.5">
              drill case timeline <ExternalLink className="w-3.5 h-3.5" />
            </Link>.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">Dismiss</Button>
      </div>
      <ul className="mt-5 space-y-3 bg-[var(--surface-alt)] p-[var(--space-md)] rounded-[var(--radius-md)]">
        {result.steps.map((s, i) => (
          <li key={i} className="text-[var(--text-sm)] flex gap-3 items-start">
            <CircleCheck className="w-4 h-4 text-[var(--status-green-fg)] shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-[var(--text-primary)]">{s.step}:</span>{' '}
              <span className="text-[var(--text-secondary)] font-medium">{s.attack}</span>
              <div className="text-[var(--status-green-fg)] font-bold mt-0.5">{s.outcome}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GuardrailCard({ guardrail: g }: { guardrail: Guardrail }) {
  const [open, setOpen] = useState(false);
  const sevStyle = SEVERITY_STYLE[g.severity] ?? { bg: 'var(--status-gray-bg)', fg: 'var(--status-gray-fg)' };

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }} className="group transition-colors last:border-0 bg-[var(--surface)]">
      <button
        className="w-full text-left flex items-center gap-4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
        style={{ padding: '12px var(--space-lg)' }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-soft)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldCheck className="w-5 h-5 text-[var(--status-green-fg)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{g.title}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }} className="truncate font-medium">{g.threat}</div>
        </div>
        <CompactBadge bg={sevStyle.bg} fg={sevStyle.fg}>{g.severity}</CompactBadge>
        <CompactBadge bg={g.activationCount > 0 ? 'var(--status-red-bg)' : 'var(--status-gray-bg)'} fg={g.activationCount > 0 ? 'var(--status-red-fg)' : 'var(--status-gray-fg)'}>
          {g.activationCount > 0 ? `${g.activationCount}× intervened` : 'No interventions'}
        </CompactBadge>
        {open ? <ChevronUp className="w-5 h-5 shrink-0 text-[var(--text-muted)]" /> : <ChevronDown className="w-5 h-5 shrink-0 text-[var(--text-muted)]" />}
      </button>
      {open && <GuardrailDetail guardrail={g} />}
    </div>
  );
}

function GuardrailDetail({ guardrail: g }: { guardrail: Guardrail }) {
  const { data: events, isLoading } = useListGuardrailEvents(g.key, {
    query: { queryKey: getListGuardrailEventsQueryKey(g.key) },
  });
  return (
    <div className="px-[var(--space-lg)] py-[var(--space-lg)] space-y-6 text-[var(--text-sm)] bg-[var(--surface-alt)] border-t border-[var(--border)]">
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">What it prevents</div>
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)] font-medium leading-relaxed">{g.threat}</p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">How it works</div>
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)] font-medium leading-relaxed">{g.mechanism}</p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">When it triggers</div>
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)] font-medium leading-relaxed">{g.onViolation}</p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" /> Enforced at
          </div>
          <div className="flex flex-wrap gap-1.5">
            {g.enforcedAt.map((e, i) => (
              <span key={i} className="font-mono text-[11px] bg-[var(--surface-soft)] text-[var(--text-secondary)] rounded-[var(--radius-sm)] px-2 py-1 font-semibold inline-block">{e}</span>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-2.5 flex items-center gap-1.5">
          <FlaskConical className="w-3.5 h-3.5" /> How it's evaluated
        </div>
        <div className="flex flex-wrap gap-2">
          {g.evals.map((e, i) => {
            let bg = 'var(--status-gray-bg)', fg = 'var(--status-gray-fg)';
            if (e.kind === 'live-verified') { bg = 'var(--status-green-bg)'; fg = 'var(--status-green-fg)'; }
            else if (e.kind === 'automated-test') { bg = 'var(--status-info-bg)'; fg = 'var(--status-info-fg)'; }
            return (
              <CompactBadge key={i} bg={bg} fg={fg}>
                {e.kind === 'automated-test' ? <FlaskConical className="w-3 h-3" /> : <CircleCheck className="w-3 h-3" />}
                {e.name}
              </CompactBadge>
            );
          })}
        </div>
      </div>

      <div className="pt-3 border-t border-[var(--border)]">
        <div className="font-semibold text-[var(--text-xs)] uppercase tracking-wider text-[var(--text-muted)] mb-3 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" /> Recent interventions
        </div>
        {isLoading ? (
          <p className="text-[var(--text-muted)] text-[var(--text-sm)] font-medium">Loading…</p>
        ) : !events || events.length === 0 ? (
          <div className="bg-[var(--surface-soft)] p-[var(--space-md)] rounded-[var(--radius-md)] text-[var(--text-secondary)] text-[var(--text-sm)] flex items-center gap-2.5 font-medium">
            <Shield className="w-4 h-4 text-[var(--text-muted)]" />
            This guardrail has not needed to intervene yet. Run the security drill to see it in action.
          </div>
        ) : (
          <ul className="space-y-3 mt-3">
            {events.map((ev) => (
              <li key={ev.id} className="flex gap-4 items-start bg-[var(--surface)] p-[var(--space-md)] rounded-[var(--radius-md)] shadow-[var(--shadow-sm)] border border-[var(--border)]">
                <div className="shrink-0 mt-0.5">
                  <CompactBadge bg={ACTION_STYLE[ev.action]?.bg ?? 'var(--status-gray-bg)'} fg={ACTION_STYLE[ev.action]?.fg ?? 'var(--status-gray-fg)'}>{ev.action}</CompactBadge>
                </div>
                <div className="min-w-0">
                  <p className="break-words font-semibold leading-relaxed text-[var(--text-sm)] text-[var(--text-primary)]">{ev.detail}</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1.5 font-medium">
                    {format(new Date(ev.createdAt), 'MMM d, yyyy HH:mm:ss')}
                    {ev.caseId != null && (
                      <>
                        <span className="mx-2 text-[var(--border-strong)]">•</span>
                        <Link href={`/cases/${ev.caseId}`} className="text-[var(--primary)] hover:underline inline-flex items-center gap-1 font-semibold">
                          {ev.workerName ?? `case #${ev.caseId}`}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
