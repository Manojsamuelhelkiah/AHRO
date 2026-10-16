import React, { useMemo } from 'react';
import { lifecycleStageText } from '../lib/lifecycle-stage-presentation';
import {
  useGetOnboardingDashboard,
  useListOnboardingCases,
  useListOnboardingApprovals,
} from '@workspace/api-client-react';
import type { OnbCase, OnbApproval, OnbEvent } from '@workspace/api-client-react';
import { Card, PageHeader, Button } from '@/components/ui-shared';
import { Link } from 'wouter';
import { Activity, Bot, CheckCircle2, ShieldAlert, UserCheck, Layers, AlertOctagon, Timer } from 'lucide-react';
import { EngineBadge } from '@/components/engine-badge';
import { formatDistanceToNowStrict } from 'date-fns';
import { WorkforceReviewPanel } from '@/components/workforce-insights/workforce-review-panel';
import { statusOf, caseTypeOf } from './cases/index';
import { operationalReportingPopulation } from '../lib/operational-reporting';

/* ----------------------------- derived metrics ---------------------------- */

function isActive(c: OnbCase) {
  return statusOf(c) !== 'Completed';
}

/** Mirrors the backend's day-1-risk derivation: the effective date is inside the
 *  next 7 days while the case is blocked, awaiting approval, or has open
 *  workstream blockers. Past effective dates are excluded, matching the backend. */
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

/* --------------------------------- page ---------------------------------- */

export function DashboardPage() {
  const dash = useGetOnboardingDashboard();
  const casesQ = useListOnboardingCases();
  const approvalsQ = useListOnboardingApprovals({ status: 'all' });

  const { cases, approvals } = operationalReportingPopulation(casesQ.data ?? [], approvalsQ.data ?? []);
  const pendingApprovals = useMemo(() => approvals.filter((a) => a.status === 'pending'), [approvals]);

  const metrics = useMemo(() => {
    const active = cases.filter(isActive);
    const completed = cases.filter((c) => statusOf(c) === 'Completed');
    const blocked = cases.filter((c) => statusOf(c) === 'Blocked');
    const humanReview = cases.filter((c) => statusOf(c) === 'Human Review');
    const atRisk = cases.filter(slaAtRisk);

    // Autonomously resolved: completed cases that never raised a human approval.
    // Only computable when approvals history (status=all) has loaded.
    let autonomousPct: number | null = null;
    let autonomousSplit: { autonomous: number; assisted: number } | null = null;
    // Fictional completed stages are still counted as statuses, never as a
    // verified autonomous resolution or measured business success.
    const measurable = completed.filter(c => !c.offlineSample);
    if (measurable.length > 0 && approvalsQ.isSuccess) {
      const caseIdsWithApproval = new Set(approvals.map((a) => a.caseId));
      const autonomous = measurable.filter((c) => !caseIdsWithApproval.has(c.id)).length;
      autonomousPct = Math.round((autonomous / measurable.length) * 100);
      autonomousSplit = { autonomous, assisted: measurable.length - autonomous };
    }

    return { active, completed, blocked, humanReview, atRisk, autonomousPct, autonomousSplit };
  }, [cases, approvals, approvalsQ.isSuccess]);

  const stageMetrics = useMemo(() => {
    const active = cases.filter(isActive);
    const agg = {
      a: { pending: 0, 'human-review': 0, blocked: 0 },
      b: { pending: 0, 'human-review': 0, blocked: 0 },
      c: { pending: 0, 'human-review': 0, blocked: 0 },
    };
    active.forEach(c => {
      if (!c.gateways) return;
      ['a', 'b', 'c'].forEach(k => {
        const key = k as 'a'|'b'|'c';
        const st = c.gateways[key]?.status;
        if (st === 'pending' || st === 'human-review' || st === 'blocked') {
          agg[key][st]++;
        }
      });
    });
    return agg;
  }, [cases]);

  // Unique cases needing human judgment: union of cases with pending approvals
  // and cases currently in Human Review.
  const interventionCount = useMemo(() => {
    const ids = new Set<number>(pendingApprovals.map((a) => a.caseId));
    for (const c of metrics.humanReview) ids.add(c.id);
    return ids.size;
  }, [pendingApprovals, metrics.humanReview]);

  const domains = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of metrics.active) {
      const d = caseTypeOf(c) === 'Employee Changes' ? 'Employee Changes' : 'Onboarding';
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [metrics.active]);

  const kpisLoading = casesQ.isLoading || approvalsQ.isLoading;

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader
        title="HRO Control Tower"
        subtitle="Track authorized cases, outstanding requirements and recorded outcomes. Verified business results are reported separately."
      />

      {/* Operations briefing */}
      <OpsBriefing
        loading={kpisLoading}
        unavailable={casesQ.isError || approvalsQ.isError}
        active={metrics.active.length}
        blocked={metrics.blocked.length}
        atRisk={metrics.atRisk.length}
        interventions={interventionCount}
        autonomousPct={metrics.autonomousPct}
      />

      {/* KPIs */}
      {casesQ.isError ? (
        <SectionError label="Operational metrics unavailable" onRetry={() => casesQ.refetch()} />
      ) : (
        <div aria-label="Dashboard summary" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <KpiCard loading={kpisLoading} title="Active Cases" value={metrics.active.length} context="Across all HRO domains" icon={Layers} tone="indigo" />
          <KpiCard
            loading={kpisLoading}
            title="Autonomously Resolved"
            value={metrics.autonomousPct === null ? '—' : `${metrics.autonomousPct}%`}
            context={metrics.autonomousPct === null ? 'Insufficient data' : 'Eligible cases completed autonomously'}
            icon={Bot}
            tone="indigo"
          />
          <KpiCard
            loading={kpisLoading}
            title="Human Interventions"
            value={interventionCount}
            context="Requires attention"
            icon={UserCheck}
            tone={interventionCount > 0 ? 'amber' : 'neutral'}
          />
          <KpiCard
            loading={kpisLoading}
            title="SLA At Risk"
            value={metrics.atRisk.length}
            context="Effective date within 7 days while held up"
            icon={Timer}
            tone={metrics.atRisk.length > 0 ? 'amber' : 'neutral'}
          />
          <KpiCard
            loading={kpisLoading}
            title="Blocked Cases"
            value={metrics.blocked.length}
            context={metrics.blocked.length > 0 ? 'Unable to proceed' : 'None blocked'}
            icon={AlertOctagon}
            tone={metrics.blocked.length > 0 ? 'red' : 'green'}
          />
          <StageSummaryCard loading={casesQ.isLoading} title="Offer-Acceptance Package" metrics={stageMetrics.a} />
          <StageSummaryCard loading={casesQ.isLoading} title="Background Checks" metrics={stageMetrics.b} />
          <StageSummaryCard loading={casesQ.isLoading} title="Day-1 Readiness" metrics={stageMetrics.c} />
        </div>
      )}

      <WorkforceReviewPanel />

      {/* Activity + Human Attention */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 overflow-hidden p-0 shadow-sm order-2 lg:order-1">
          <div className="ct-section-band" style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }}>
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[var(--primary)]" /> Agent Activity
            </h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
              Recent autonomous actions, policy decisions, and human handoffs.
            </p>
          </div>
          {dash.isLoading ? (
            <SkeletonRows rows={6} />
          ) : dash.isError ? (
            <div style={{ padding: 'var(--space-xl)', textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Agent activity unavailable</p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>Activity couldn't be loaded. Try again.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => dash.refetch()}>Retry</Button>
            </div>
          ) : !dash.data?.recentEvents?.length ? (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: 'var(--space-xl)', textAlign: 'center' }}>No recent agent activity</p>
          ) : (
            <ul className="list-none m-0 p-0">
              {dash.data.recentEvents.slice(0, 8).map((event, i, arr) => (
                <ActivityRow key={event.id} event={event} last={i === arr.length - 1} />
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden p-0 shadow-sm order-1 lg:order-2">
          <div className="ct-section-band" style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }}>
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="flex items-center gap-2">
              <UserCheck className="w-4 h-4" style={{ color: 'var(--status-amber)' }} /> Human Attention Required
            </h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
              Cases requiring judgment, approval, or exception handling.
            </p>
          </div>
          {approvalsQ.isLoading ? (
            <SkeletonRows rows={3} />
          ) : approvalsQ.isError ? (
            <div style={{ padding: 'var(--space-xl)', textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Interventions unavailable</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => approvalsQ.refetch()}>Retry</Button>
            </div>
          ) : pendingApprovals.length === 0 ? (
            <div style={{ padding: 'var(--space-xl)', textAlign: 'center' }}>
              <CheckCircle2 className="w-5 h-5 mx-auto" style={{ color: 'var(--status-green)' }} aria-hidden />
              <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', marginTop: '8px' }}>No interventions required</p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                Autonomous operations are proceeding within configured guardrails.
              </p>
            </div>
          ) : (
            <ul className="list-none m-0 p-0">
              {pendingApprovals.slice(0, 5).map((a, i, arr) => (
                <AttentionRow key={a.id} approval={a} last={i === arr.length - 1} />
              ))}
            </ul>
          )}
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px var(--space-lg)' }}>
            <Link href="/approvals" className="hover:underline" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--primary)' }}>
              View all interventions →
            </Link>
          </div>
        </Card>
      </div>

      {/* Cases by domain + execution model */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 p-0 overflow-hidden shadow-sm">
          <div className="ct-section-band" style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }}>
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Cases by HRO Domain</h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>Active workload across the HR lifecycle.</p>
          </div>
          <div style={{ padding: 'var(--space-lg)' }}>
            {casesQ.isLoading ? (
              <SkeletonRows rows={2} />
            ) : casesQ.isError ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-md)' }}>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Domain workload unavailable</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => casesQ.refetch()}>Retry</Button>
              </div>
            ) : domains.length === 0 ? (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-md)' }}>No active cases</p>
            ) : (
              <div className="space-y-3" role="img" aria-label={`Active cases by domain: ${domains.map(([d, n]) => `${d} ${n}`).join(', ')}`}>
                {domains.map(([domain, count]) => {
                  const max = domains[0][1];
                  return (
                    <div key={domain} className="flex items-center gap-3">
                      <span style={{ width: '150px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 500 }} className="shrink-0">{domain}</span>
                      <div className="flex-1 rounded-full overflow-hidden" style={{ height: '8px', backgroundColor: 'var(--surface-alt)' }}>
                        <div style={{ width: `${(count / max) * 100}%`, height: '100%', backgroundColor: 'var(--primary)', opacity: 0.85, borderRadius: '999px' }} />
                      </div>
                      <span style={{ width: '32px', textAlign: 'right', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <Card className="p-0 overflow-hidden shadow-sm">
          <div className="ct-section-band" style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }}>
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Execution Model</h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>How completed work was resolved.</p>
          </div>
          <div style={{ padding: 'var(--space-lg)' }}>
            {casesQ.isLoading || approvalsQ.isLoading ? (
              <SkeletonRows rows={2} />
            ) : casesQ.isError || approvalsQ.isError ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-md)' }}>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>Execution data unavailable</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => { casesQ.refetch(); approvalsQ.refetch(); }}>Retry</Button>
              </div>
            ) : !metrics.autonomousSplit ? (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-md)' }}>
                — <span style={{ display: 'block', fontSize: 'var(--text-xs)', marginTop: '4px' }}>Insufficient data</span>
              </p>
            ) : (
              <div className="space-y-3">
                <ExecRow label="Autonomous" count={metrics.autonomousSplit.autonomous} total={metrics.completed.length} color="var(--primary)" />
                <ExecRow label="Human Assisted" count={metrics.autonomousSplit.assisted} total={metrics.completed.length} color="var(--status-amber)" />
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------- components ------------------------------- */

type Tone = 'indigo' | 'amber' | 'red' | 'green' | 'neutral';
const TONE_COLOR: Record<Tone, string> = {
  indigo: 'var(--primary)',
  amber: 'var(--status-amber-fg)',
  red: 'var(--status-red)',
  green: 'var(--status-green-fg)',
  neutral: 'var(--text-muted)',
};

function OpsBriefing({ loading, unavailable, active, blocked, atRisk, interventions, autonomousPct }: {
  loading?: boolean;
  unavailable?: boolean;
  active: number;
  blocked: number;
  atRisk: number;
  interventions: number;
  autonomousPct: number | null;
}) {
  const healthy = !unavailable && blocked === 0 && atRisk === 0;
  const headline = unavailable
    ? 'Operations status unavailable'
    : loading
      ? 'Assessing operations…'
      : healthy
        ? 'Operations are healthy'
        : blocked > 0
          ? 'Operations require attention'
          : 'Operations are progressing with items to watch';

  let body: string;
  if (unavailable) {
    body = 'Live operational data could not be loaded. Metrics will resume once the connection is restored.';
  } else if (loading) {
    body = 'Gathering live case, agent, and intervention data…';
  } else {
    const parts: string[] = [];
    parts.push(`${active} active ${active === 1 ? 'case is' : 'cases are'} being handled across the agent workforce.`);
    if (autonomousPct !== null) parts.push(`${autonomousPct}% of eligible work has completed autonomously.`);
    if (interventions > 0) parts.push(`${interventions} ${interventions === 1 ? 'case requires' : 'cases require'} human attention.`);
    if (atRisk > 0) parts.push(`${atRisk} ${atRisk === 1 ? 'SLA is' : 'SLAs are'} at risk.`);
    if (blocked > 0) parts.push(`${blocked} ${blocked === 1 ? 'case is' : 'cases are'} blocked.`);
    if (interventions === 0 && atRisk === 0 && blocked === 0) parts.push('No human interventions are currently required.');
    body = parts.join(' ');
  }

  const dotColor = unavailable || loading ? 'var(--status-gray)' : healthy ? 'var(--status-green)' : blocked > 0 ? 'var(--status-red)' : 'var(--status-amber)';

  return (
    <div
      className="flex items-start gap-3"
      style={{
        backgroundColor: 'var(--surface)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-lg) var(--space-xl)',
        boxShadow: 'var(--shadow-sm)',
      }}
      role="status"
    >
      <span aria-hidden className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
      <div className="min-w-0">
        <p style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>{headline}</p>
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

function ActivityRow({ event, last }: { event: OnbEvent; last: boolean }) {
  const domain = 'Onboarding';
  const inner = (
    <div className="flex items-start gap-3" style={{ padding: '10px var(--space-lg)', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div className="shrink-0 mt-0.5"><EngineBadge engine={event.engine} /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{lifecycleStageText(event.title)}</p>
        <p className="line-clamp-1" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>{lifecycleStageText(event.detail)}</p>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '3px' }}>
          {domain} · {event.agent} · {ago(event.createdAt)} ago
        </p>
      </div>
      {event.caseId != null && (
        <span className="shrink-0 self-center" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)' }}>View details</span>
      )}
    </div>
  );
  return (
    <li>
      {event.caseId != null ? (
        <Link href={`/cases/${event.caseId}`} className="block transition-colors hover:bg-[var(--surface-alt)]" aria-label={`Open case ${event.caseId}: ${lifecycleStageText(event.title)}`}>
          {inner}
        </Link>
      ) : inner}
    </li>
  );
}

function AttentionRow({ approval, last }: { approval: OnbApproval; last: boolean }) {
  const isSla = approval.ruleRef?.includes('sla') || approval.ruleRef?.includes('readiness') || approval.agent === 'readiness-watcher' || approval.agent === 'system-watcher';
  const isBreached = approval.recommendation?.toLowerCase().includes('breach') || approval.rationale?.toLowerCase().includes('breach');
  const priority = isBreached || approval.hitlPattern === 'hard-block' ? 'High priority' : 'Medium priority';
  const pColor = isBreached || approval.hitlPattern === 'hard-block' ? 'var(--status-red)' : 'var(--status-amber)';

  return (
    <li>
      <Link href={isSla ? `/cases/${approval.caseId}` : `/approvals`} className="block transition-colors hover:bg-[var(--surface-alt)]" aria-label={`Open intervention for ${approval.caseWorkerName}`}>
        <div style={{ padding: '10px var(--space-lg)', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
          <div className="flex items-center justify-between gap-2">
            <p className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {isSla ? (isBreached ? 'SLA Breached' : 'SLA Action Due') : (approval.hitlPattern === 'hard-block' ? 'Decision required' : 'Approval required')} — {approval.caseWorkerName}
            </p>
            {isSla && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-muted)] border border-[var(--border)] px-1.5 py-0.5 rounded bg-[var(--surface)] shrink-0">SLA Alert</span>}
          </div>
          <p className="line-clamp-2" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>{lifecycleStageText(approval.recommendation)}</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '3px' }}>
            Onboarding · <span style={{ color: pColor, fontWeight: 600 }}>{priority}</span> · {ago(approval.createdAt)}
          </p>
        </div>
      </Link>
    </li>
  );
}

function ExecRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span style={{ width: '110px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 500 }} className="shrink-0">{label}</span>
      <div className="flex-1 rounded-full overflow-hidden" style={{ height: '8px', backgroundColor: 'var(--surface-alt)' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, opacity: 0.85, borderRadius: '999px' }} />
      </div>
      <span style={{ width: '64px', textAlign: 'right', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>{count} · {pct}%</span>
    </div>
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
