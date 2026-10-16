import React, { useMemo } from 'react';
import { lifecycleStageText } from '../lib/lifecycle-stage-presentation';
import type { OnbCase } from '@workspace/api-client-react';
import { Card, PageHeader, Button } from '@/components/ui-shared';
import { Link } from 'wouter';
import { Activity, Bot, ShieldAlert, UserCheck, Layers, AlertOctagon, Timer } from 'lucide-react';
import { EngineBadge } from '@/components/engine-badge';
import { formatDistanceToNowStrict } from 'date-fns';
import { WorkforceReviewPanel } from '@/components/workforce-insights/workforce-review-panel';
import { statusOf, caseIsActive } from './cases/case-presentation';
import { operationalReportingPopulation } from '../lib/operational-reporting';
import { useControlTower } from '../hooks/use-control-tower';
import { projectAttention, familyWorkload, executionEvidence, composeActivity, liveReliability, sourceDisclosures, type AttentionItem } from '../lib/control-tower';
import { ActivityPanel, ReliabilityPanel } from '../components/control-tower/panels';
import { ExamplesSection } from '../components/control-tower/examples-section';

function isActive(c: OnbCase) {
  return caseIsActive(c);
}

/** Mirrors the backend's day-1-risk derivation. */
function slaAtRisk(c: OnbCase): boolean {
  if (!isActive(c)) return false;
  const days = (new Date(c.joiningDate).getTime() - Date.now()) / 86400000;
  if (days < 0 || days > 7) return false;
  return (
    c.orchestrationStatus === 'blocked' ||
    c.orchestrationStatus === 'waiting-approval' ||
    (c.workstreams ?? []).some((w) => (w.blockers ?? []).length > 0)
  );
}

function ago(iso: string): string {
  try { return formatDistanceToNowStrict(new Date(iso), { addSuffix: false }); } catch { return ''; }
}

const stamp = (d: Date | null) => (d ? `Last successful update ${d.toLocaleTimeString()}` : 'Not yet loaded');
export function DashboardPage() {
  const ct = useControlTower();
  const { dash, cases: casesQ, actions: actionsQ, examples: examplesQ, reviews } = ct;
  const cases = useMemo(() => (casesQ.isError || !casesQ.data ? [] : operationalReportingPopulation(casesQ.data, []).cases), [casesQ.data, casesQ.isError]);
  const actionData = ct.actionsData.data;
  const projection = useMemo(() => projectAttention(actionData, reviews.data), [actionData, reviews.data]);

  const metrics = useMemo(() => {
    const active = cases.filter(isActive);
    return {
      active,
      completed: cases.filter((c) => statusOf(c) === 'Completed'),
      blocked: cases.filter((c) => statusOf(c) === 'Blocked'),
      atRisk: cases.filter(slaAtRisk),
    };
  }, [cases]);
  const families = useMemo(() => familyWorkload(cases, actionData?.caseSummaries), [cases, actionData]);
  const familyTotal = families.reduce((n, f) => n + f.total, 0);
  const familyActive = families.reduce((n, f) => n + f.active, 0);
  const evidence = executionEvidence(families.reduce((sum, family) => sum + family.completed, 0));

  const stageMetrics = useMemo(() => {
    const agg = { a: { pending: 0, 'human-review': 0, blocked: 0 }, b: { pending: 0, 'human-review': 0, blocked: 0 }, c: { pending: 0, 'human-review': 0, blocked: 0 } };
    metrics.active.forEach((c) => {
      if (!c.gateways) return;
      (['a', 'b', 'c'] as const).forEach((key) => {
        const st = c.gateways![key]?.status;
        if (st === 'pending' || st === 'human-review' || st === 'blocked') agg[key][st]++;
      });
    });
    return agg;
  }, [metrics.active]);

  const casesFailed = casesQ.isError;
  const casesLoading = casesQ.isLoading;
  const attentionLoading = actionsQ.isLoading;
  const attentionFailed = actionsQ.isError;
  const events = ct.dashData.data?.recentEvents ?? [];
  const offSrc = actionData?.offboardingSource;
  const familyPartial = !actionData || offSrc !== 'available';
  const activity = useMemo(() => composeActivity(ct.dashData.data?.recentEvents, actionData, cases), [ct.dashData.data, actionData, cases]);
  const reliability = useMemo(() => liveReliability(actionData, casesQ.isError || !casesQ.data ? undefined : cases), [actionData, cases, casesQ.isError, casesQ.data]);
  const disclosures = useMemo(() => sourceDisclosures(actionData), [actionData]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader
        title="HRO Control Tower"
        subtitle="Track authorized cases, outstanding requirements and recorded outcomes. Verified business results are reported separately."
      />

      <OpsBriefing loading={casesLoading} unavailable={casesFailed} active={familyActive} blocked={metrics.blocked.length}
        atRisk={metrics.atRisk.length} interventions={attentionFailed ? null : projection.total} autonomousPct={null} />

      {casesFailed && <SectionError label="Case workload unavailable" onRetry={() => casesQ.refetch()} />}
      <div aria-label="Dashboard summary" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {!casesFailed && <KpiCard loading={casesLoading} title="Active Cases" value={familyPartial ? `${familyActive} known` : familyActive} context={`${familyPartial ? 'Partial coverage — separate offboarding not fully available' : 'Authorized cases incl. separate offboarding'} · ${stamp(ct.casesData.updatedAt)}`} icon={Layers} tone="indigo" />}
        <KpiCard loading={casesLoading} title="Autonomously Resolved" value="Not assessed"
          context={casesFailed ? 'Completed-case count unavailable (cases source failed). 0 verified autonomous · 0 verified human-assisted.' : `${evidence.verifiedAutonomous} verified autonomous · ${evidence.verifiedHumanAssisted} verified human-assisted · ${evidence.unknown} of ${evidence.denominator} completed unknown (no measured evidence mapped)`} icon={Bot} tone="neutral" />
        <KpiCard loading={attentionLoading} title="Human Attention Required" value={attentionFailed ? 'Unavailable' : projection.total}
          context={attentionFailed ? 'Action Center source failed — total unknown' : `${projection.incomplete ? 'Known work items only — total incomplete' : 'Same count as Action Center'} · ${stamp(ct.actionsData.updatedAt)}`} icon={UserCheck} tone={projection.total > 0 ? 'amber' : 'neutral'} />
        {!casesFailed && <>
          <KpiCard loading={casesLoading} title="SLA At Risk" value={metrics.atRisk.length} context="Effective date within 7 days while held up" icon={Timer} tone={metrics.atRisk.length > 0 ? 'amber' : 'neutral'} />
          <KpiCard loading={casesLoading} title="Blocked Cases" value={metrics.blocked.length} context={metrics.blocked.length > 0 ? 'Unable to proceed' : 'None recorded as blocked'} icon={AlertOctagon} tone={metrics.blocked.length > 0 ? 'red' : 'neutral'} />
          <StageSummaryCard loading={casesLoading} title="Offer-Acceptance Package" metrics={stageMetrics.a} />
          <StageSummaryCard loading={casesLoading} title="Background Checks" metrics={stageMetrics.b} />
          <StageSummaryCard loading={casesLoading} title="Day-1 Readiness" metrics={stageMetrics.c} />
        </>}
      </div>

      <WorkforceReviewPanel />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 order-2 lg:order-1 min-w-0">
          <ActivityPanel title="Agent Activity" items={activity} loading={!activity.length && (dash.isLoading || actionsQ.isLoading)} failed={dash.isError && actionsQ.isError}
            partialFailure={dash.isError || actionsQ.isError}
            retry={() => { dash.refetch(); actionsQ.refetch(); }} updatedAt={ct.dashData.updatedAt ?? ct.actionsData.updatedAt}
            coverage={`Sources: dashboard events ${dash.isError ? '(unavailable)' : 'available'}; Action Center notifications, completed actions and domain records ${attentionFailed ? '(unavailable)' : 'available'}. Bounded lists — not complete history.`} />
        </div>

        <Card className="overflow-hidden p-0 shadow-sm order-1 lg:order-2">
          <PanelHead icon={<UserCheck className="w-4 h-4" style={{ color: 'var(--status-amber)' }} />} title="Human Attention Required"
            sub={`Count unit: outstanding work items. ${stamp(ct.actionsData.updatedAt)}.`} />
          {attentionLoading ? <SkeletonRows rows={3} /> : attentionFailed ? (
            <div role="alert" style={{ padding: 'var(--space-xl)', textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Outstanding work unavailable</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => actionsQ.refetch()}>Retry</Button>
            </div>
          ) : projection.total === 0 ? (
            <div style={{ padding: 'var(--space-xl)', textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>No outstanding items recorded</p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                An empty queue is not evidence of health or autonomy{reviews.data ? '' : '; early-warning reviews were not available'}.
              </p>
            </div>
          ) : (
            <ul className="list-none m-0 p-0">
              {projection.items.slice(0, 5).map((a, i, arr) => <AttentionRow key={a.key} item={a} last={i === arr.length - 1} />)}
            </ul>
          )}
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px var(--space-lg)' }}>
            <p className="text-[11px] text-[var(--text-muted)]" data-testid="dash-attention-total">
              {attentionFailed ? 'Total unavailable — no queue conclusion.' : <>{projection.total} total{projection.incomplete ? ' in available sources — incomplete' : ''}; {projection.historicalNotifications} historical notifications not counted.</>}
              {actionData && actionData.approvals.length + actionData.workItems.length >= 200 ? ' Lists may be capped at 200.' : ''}
              {disclosures.filter((d) => d.capped).length > 0 && <span className="block" data-testid="attention-truncation">Not complete: {disclosures.filter((d) => d.capped).map((d) => `${d.label} ${d.shown} of ${d.available}`).join('; ')}.</span>}
            </p>
            <Link href="/approvals" className="hover:underline" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--primary)' }}>View Action Center →</Link>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 p-0 overflow-hidden shadow-sm">
          <PanelHead title="Cases by HRO Domain" sub={`${casesFailed ? 'Case cohort unavailable' : `${familyActive} ${familyPartial ? 'known ' : ''}active of ${familyTotal} authorized records${familyPartial ? ' — coverage partial' : ''}`}. ${stamp(ct.casesData.updatedAt)}.`} />
          <div style={{ padding: 'var(--space-lg)' }}>
            {casesLoading ? <SkeletonRows rows={3} /> : casesFailed ? (
              <div role="alert" style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Family workload unavailable</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => casesQ.refetch()}>Retry</Button>
              </div>
            ) : (
              <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0 sm:grid-cols-2" data-testid="family-list">
                {families.map((f) => (
                  <li key={f.family}>
                    <div className="flex min-h-10 items-center justify-between gap-2 rounded px-2">
                      <Link href={f.href} className="min-w-0 break-words text-sm text-[var(--text-secondary)] hover:underline" data-testid={`family-${f.family}`}>{f.family}</Link>
                      <span className="text-right text-sm font-bold"><Link href={f.activeHref} className="hover:underline" data-testid={`family-active-${f.family}`}>{f.active} {f.family === 'Offboarding' && familyPartial ? 'known active' : 'active'}</Link> / {f.total}
                        {f.family === 'Offboarding' && familyPartial && <small className="block text-[10px] font-normal text-[var(--text-muted)]">Additional workload unknown</small>}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {attentionFailed && <p role="status" className="mt-2 text-xs text-[var(--status-amber-fg)]" data-testid="offboarding-source">Offboarding coverage unavailable (Action Center failed). Family counts may omit separate offboarding records.</p>}
            {!attentionFailed && offSrc && offSrc !== 'available' && <p role="status" className="mt-2 text-xs text-[var(--status-amber-fg)]" data-testid="offboarding-source">Offboarding source: {offSrc}. Offboarding counts may be incomplete.</p>}
          </div>
        </Card>

        <Card className="p-0 overflow-hidden shadow-sm">
          <PanelHead title="Execution Model" sub={`Whole-case verified outcomes. ${stamp(ct.casesData.updatedAt)}.`} />
          <div style={{ padding: 'var(--space-lg)' }} className="space-y-1 text-sm" data-testid="execution-evidence">
            {casesLoading ? <SkeletonRows rows={2} /> : casesFailed ? <div role="alert"><p>Execution data unavailable</p><Button size="sm" variant="outline" className="mt-2" onClick={() => casesQ.refetch()}>Retry</Button></div> : <>
              <p>Verified autonomous: <strong>{evidence.verifiedAutonomous}</strong></p>
              <p>Verified human-assisted: <strong>{evidence.verifiedHumanAssisted}</strong></p>
              <p>Unknown: <strong>{evidence.unknown}</strong> of {evidence.denominator} completed (no measured historical evidence mapped)</p>
              <p className="text-xs text-[var(--text-muted)]">{evidence.note}</p>
            </>}
          </div>
        </Card>
      </div>

      <section aria-labelledby="oraq-h" className="space-y-3" data-testid="reliability-quality">
        <h2 id="oraq-h" className="text-base font-semibold text-[var(--text-primary)]">Operational Reliability &amp; AI Quality</h2>
        <ReliabilityPanel data={reliability} loading={attentionLoading} failed={attentionFailed} retry={() => actionsQ.refetch()} disclosures={disclosures} updatedAt={ct.actionsData.updatedAt} offboardingSource={attentionFailed ? 'unavailable' : offSrc} />
        <ExamplesSection data={ct.examplesData.data} loading={examplesQ.isLoading} failed={examplesQ.isError} retry={() => examplesQ.refetch()} updatedAt={ct.examplesData.updatedAt} />
      </section>
    </div>
  );
}

function PanelHead({ icon, title, sub }: { icon?: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="ct-section-band" style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--band-bg, var(--surface-alt))' }}>
      <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }} className="flex items-center gap-2">{icon}{title}</h2>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</p>
    </div>
  );
}
type Tone = 'indigo' | 'amber' | 'red' | 'green' | 'neutral';
const TONE_COLOR: Record<Tone, string> = {
  indigo: 'var(--primary)',
  amber: 'var(--status-amber-fg)',
  red: 'var(--status-red)',
  green: 'var(--status-green-fg)',
  neutral: 'var(--text-muted)',
};

function OpsBriefing({ loading, unavailable, active, blocked, atRisk, interventions }: {
  loading?: boolean; unavailable?: boolean; active: number; blocked: number; atRisk: number;
  interventions: number | null; autonomousPct: number | null;
}) {
  const headline = unavailable ? 'Operations status unavailable' : loading ? 'Assessing operations…'
    : blocked > 0 ? 'Operations require attention' : atRisk > 0 ? 'Items to watch' : 'No blocked or at-risk cases recorded';
  const body = unavailable ? 'Case data could not be loaded. Other panels load independently.'
    : loading ? 'Gathering case data…'
    : [`${active} active ${active === 1 ? 'case' : 'cases'}.`,
       interventions === null ? 'Outstanding work unavailable.' : `${interventions} outstanding work ${interventions === 1 ? 'item' : 'items'}.`,
       `${atRisk} at risk, ${blocked} blocked.`, 'Autonomy and business outcomes are not assessed.'].join(' ');
  const dotColor = unavailable || loading ? 'var(--status-gray)' : blocked > 0 ? 'var(--status-red)' : atRisk > 0 ? 'var(--status-amber)' : 'var(--status-gray)';
  return (
    <div className="flex items-start gap-3" style={{ backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-md)', padding: 'var(--space-lg) var(--space-xl)', boxShadow: 'var(--shadow-sm)' }} role="status">
      <span aria-hidden className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
      <div className="min-w-0">
        <p style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{headline}</p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '2px' }}>{body}</p>
      </div>
    </div>
  );
}

function KpiCard({ title, value, context, icon: Icon, tone, loading }: { title: string; value: React.ReactNode; context: string; icon: React.ComponentType<any>; tone: Tone; loading?: boolean }) {
  return (
    <Card style={{ padding: 'var(--space-md) var(--space-lg)' }} className="ct-summary shadow-sm">
      <div className="flex items-center gap-1.5">
        <Icon style={{ width: '14px', height: '14px', color: TONE_COLOR[tone] }} aria-hidden />
        <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', fontWeight: 700 }}>{title}</span>
      </div>
      {loading ? (
        <div className="animate-pulse rounded mt-2" style={{ height: '24px', width: '56px', backgroundColor: 'var(--surface-alt)' }} />
      ) : (
        <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, marginTop: '6px', letterSpacing: '-0.02em' }}>{value}</div>
      )}
      <div className="ct-summary-muted" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>{context}</div>
    </Card>
  );
}

function StageSummaryCard({ title, metrics, loading }: { title: string; metrics: { pending: number; 'human-review': number; blocked: number; }; loading?: boolean }) {
  return (
    <Card style={{ padding: 'var(--space-md) var(--space-lg)' }} className="min-w-0 shadow-sm flex flex-col gap-3">
      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', fontWeight: 700 }}>{title}</div>
      {loading ? (
        <div role="status" aria-label={`${title} loading`} className="animate-pulse rounded" style={{ height: '44px', backgroundColor: 'var(--surface-alt)' }} />
      ) : (
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col">
          <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--primary)' }}>{metrics.pending}</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>Pending</span>
        </div>
        <div className="flex flex-col">
          <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--status-amber)' }}>{metrics['human-review']}</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>Review</span>
        </div>
        <div className="flex flex-col">
          <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--status-red)' }}>{metrics.blocked}</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>Blocked</span>
        </div>
      </div>
      )}
    </Card>
  );
}
function AttentionRow({ item, last }: { item: AttentionItem; last: boolean }) {
  return (
    <li>
      <Link href={item.href} className="block hover:bg-[var(--surface-alt)]" data-testid={`attention-${item.key}`}>
        <div style={{ padding: '10px var(--space-lg)', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
          <p className="line-clamp-2 break-words" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{lifecycleStageText(item.title)}</p>
          <p className="break-words" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '3px' }}>
            {item.kind} · priority {item.priority ?? 'not recorded'} · owner {item.owner ?? 'not recorded'} · due {item.due ?? 'not recorded'}{item.createdAt ? ` · ${ago(item.createdAt)} ago` : ''}
          </p>
        </div>
      </Link>
    </li>
  );
}
function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div style={{ padding: 'var(--space-lg)' }} className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="animate-pulse rounded" style={{ height: '14px', width: `${85 - i * 10}%`, backgroundColor: 'var(--surface-alt)' }} />
      ))}
    </div>
  );
}

function SectionError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <Card style={{ padding: 'var(--space-xl)', textAlign: 'center' }} className="shadow-sm">
      <ShieldAlert className="w-5 h-5 mx-auto" style={{ color: 'var(--text-muted)' }} aria-hidden />
      <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', marginTop: '8px' }}>{label}</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>Retry</Button>
    </Card>
  );
}
