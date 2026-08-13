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

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-none',
  high: 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-none',
  medium: 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-none',
  low: 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] border-none',
};

const ACTION_STYLE: Record<string, string> = {
  blocked: 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-none',
  rejected: 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-none',
  'rate-limited': 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-none',
  sanitized: 'bg-[var(--status-info-bg)] text-[var(--status-info-fg)] border-none',
  escalated: 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-none',
};

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
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
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
          className="gap-2 shadow-[var(--shadow-sm)]"
        >
          <Swords className="w-4 h-4" />
          {drill.isPending ? 'Running attacks…' : 'Run security drill'}
        </Button>
      </PageHeader>

      {drillResult && <DrillResultCard result={drillResult} onDismiss={() => setDrillResult(null)} />}
      {drill.isError && (
        <Card className="p-[var(--space-lg)] border-none shadow-[var(--shadow-sm)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-[var(--text-sm)] font-medium">
          The drill could not be completed. Check the server logs and try again.
        </Card>
      )}

      <div className="flex gap-3 flex-wrap text-[var(--text-sm)] mt-2">
        <Badge className="gap-1.5 py-[4px] px-[12px] bg-[var(--surface)] text-[var(--text-secondary)] shadow-[var(--shadow-sm)] border-none font-semibold">
          <ShieldCheck className="w-4 h-4 text-[var(--status-green-fg)]" /> {guardrails.length} controls enforced
        </Badge>
        <Badge className="gap-1.5 py-[4px] px-[12px] bg-[var(--surface)] text-[var(--text-secondary)] shadow-[var(--shadow-sm)] border-none font-semibold">
          <ShieldAlert className="w-4 h-4 text-[var(--status-red-fg)]" /> {totalActivations} recorded interventions
        </Badge>
      </div>

      {isLoading ? (
        <LoadingBlock>Loading guardrails…</LoadingBlock>
      ) : (
        (data?.categories ?? []).map((cat) => {
          const items = guardrails.filter((g) => g.category === cat.key);
          if (items.length === 0) return null;
          return (
            <section key={cat.key} className="space-y-4 pt-4">
              <SectionHeading title={cat.title} description={cat.blurb} />
              <div className="space-y-3">
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
  return (
    <div className="bg-[var(--surface)] shadow-[var(--shadow-sm)] rounded-[var(--radius-md)] overflow-hidden transition-all duration-200 hover:shadow-[var(--shadow-md)]">
      <button
        className="w-full text-left px-[var(--space-lg)] py-[var(--space-md)] flex items-center gap-4 transition-colors hover:bg-[var(--surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-inset"
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldCheck className="w-5 h-5 text-[var(--status-green-fg)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[var(--text-base)] text-[var(--text-primary)]">{g.title}</div>
          <div className="text-[var(--text-sm)] text-[var(--text-muted)] truncate mt-0.5 font-medium">{g.threat}</div>
        </div>
        <Badge className={cn('capitalize text-[var(--text-xs)] shadow-none font-bold', SEVERITY_STYLE[g.severity] ?? '')}>{g.severity}</Badge>
        <Badge className={cn('text-[var(--text-xs)] shadow-none border-none font-bold', g.activationCount > 0 ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]' : 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]')}>
          {g.activationCount > 0 ? `${g.activationCount}× intervened` : 'No interventions'}
        </Badge>
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
          {g.evals.map((e, i) => (
            <Badge key={i} className={cn(
              'gap-1.5 py-[2px] px-[10px] border-none shadow-none font-bold',
              e.kind === 'live-verified' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
                : e.kind === 'automated-test' ? 'bg-[var(--status-info-bg)] text-[var(--status-info-fg)]'
                : 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]',
            )}>
              {e.kind === 'automated-test' ? <FlaskConical className="w-3 h-3" /> : <CircleCheck className="w-3 h-3" />}
              {e.name}
            </Badge>
          ))}
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
                <Badge className={cn('capitalize shrink-0 mt-0.5 text-[10px] shadow-none font-bold', ACTION_STYLE[ev.action] ?? 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] border-none')}>{ev.action}</Badge>
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
