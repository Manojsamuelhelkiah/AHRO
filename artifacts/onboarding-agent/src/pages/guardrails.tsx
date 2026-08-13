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
import { Card, Button, Badge, cn, PageHeader } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Link } from 'wouter';
import {
  Shield, ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Swords,
  FlaskConical, MapPin, CircleCheck, Clock, ExternalLink,
} from 'lucide-react';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
};

const ACTION_STYLE: Record<string, string> = {
  blocked: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  'rate-limited': 'bg-orange-100 text-orange-800',
  sanitized: 'bg-amber-100 text-amber-800',
  escalated: 'bg-violet-100 text-violet-800',
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
    <div className="space-y-6 max-w-5xl mx-auto">
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
        <Card className="p-4 border-red-200 bg-red-50 text-sm text-red-800">
          The drill could not be completed. Check the server logs and try again.
        </Card>
      )}

      <div className="flex gap-3 flex-wrap text-sm">
        <Badge variant="outline" className="gap-1.5 py-1 px-3">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> {guardrails.length} controls enforced
        </Badge>
        <Badge variant="outline" className="gap-1.5 py-1 px-3">
          <ShieldAlert className="w-3.5 h-3.5 text-red-600" /> {totalActivations} recorded interventions
        </Badge>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading guardrails…</div>
      ) : (
        (data?.categories ?? []).map((cat) => {
          const items = guardrails.filter((g) => g.category === cat.key);
          if (items.length === 0) return null;
          return (
            <section key={cat.key} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">{cat.title}</h2>
                <p className="text-sm text-muted-foreground">{cat.blurb}</p>
              </div>
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
    <Card className="p-5 border-emerald-200 bg-emerald-50/60">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Swords className="w-4 h-4 text-emerald-700" />
            Security drill complete — {result.steps.length} simulated attacks, all handled
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Each attack ran through the live enforcement code, not a mock. The full story is on the{' '}
            <Link href={`/cases/${result.caseId}`} className="text-primary underline inline-flex items-center gap-0.5">
              drill case timeline <ExternalLink className="w-3 h-3" />
            </Link>.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
      <ul className="mt-3 space-y-2">
        {result.steps.map((s, i) => (
          <li key={i} className="text-sm flex gap-2">
            <CircleCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-medium">{s.step}:</span>{' '}
              <span className="text-muted-foreground">{s.attack}</span>
              <div className="text-emerald-800">{s.outcome}</div>
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
    <Card className="p-0 overflow-hidden">
      <button
        className="w-full text-left p-4 flex items-center gap-3 hover:bg-secondary/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{g.title}</div>
          <div className="text-sm text-muted-foreground truncate">{g.threat}</div>
        </div>
        <Badge variant="outline" className={cn('capitalize', SEVERITY_STYLE[g.severity] ?? '')}>{g.severity}</Badge>
        <Badge variant="outline" className={cn(g.activationCount > 0 ? 'bg-red-50 text-red-700 border-red-200' : 'text-muted-foreground')}>
          {g.activationCount > 0 ? `${g.activationCount}× intervened` : 'no interventions yet'}
        </Badge>
        {open ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
      </button>
      {open && <GuardrailDetail guardrail={g} />}
    </Card>
  );
}

function GuardrailDetail({ guardrail: g }: { guardrail: Guardrail }) {
  const { data: events, isLoading } = useListGuardrailEvents(g.key, {
    query: { queryKey: getListGuardrailEventsQueryKey(g.key) },
  });
  return (
    <div className="border-t px-4 py-4 space-y-4 text-sm bg-secondary/20">
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">What it prevents</div>
          <p>{g.threat}</p>
        </div>
        <div>
          <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">How it works</div>
          <p>{g.mechanism}</p>
        </div>
        <div>
          <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">When it triggers</div>
          <p>{g.onViolation}</p>
        </div>
        <div>
          <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> Enforced at
          </div>
          <ul className="space-y-0.5">
            {g.enforcedAt.map((e, i) => (
              <li key={i} className="font-mono text-xs bg-secondary rounded px-1.5 py-0.5 inline-block mr-1 mb-1">{e}</li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
          <FlaskConical className="w-3 h-3" /> How it's evaluated
        </div>
        <div className="flex flex-wrap gap-1.5">
          {g.evals.map((e, i) => (
            <Badge key={i} variant="outline" className={cn(
              'gap-1',
              e.kind === 'live-verified' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : e.kind === 'automated-test' ? 'bg-sky-50 text-sky-800 border-sky-200'
                : 'bg-slate-50 text-slate-700 border-slate-200',
            )}>
              {e.kind === 'automated-test' ? <FlaskConical className="w-3 h-3" /> : <CircleCheck className="w-3 h-3" />}
              {e.name}
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
          <Clock className="w-3 h-3" /> Recent interventions
        </div>
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !events || events.length === 0 ? (
          <p className="text-muted-foreground">This guardrail has not needed to intervene yet. Run the security drill to see it in action.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="flex gap-2 items-start">
                <Badge className={cn('capitalize shrink-0 mt-0.5', ACTION_STYLE[ev.action] ?? 'bg-slate-100 text-slate-700')}>{ev.action}</Badge>
                <div className="min-w-0">
                  <p className="break-words">{ev.detail}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(ev.createdAt), 'MMM d, HH:mm:ss')}
                    {ev.caseId != null && (
                      <> · <Link href={`/cases/${ev.caseId}`} className="text-primary underline">{ev.workerName ?? `case #${ev.caseId}`}</Link></>
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
