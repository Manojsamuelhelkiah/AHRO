import { Link } from 'wouter';
import type { ActivityItem, Reliability, SourceDisclosure } from '../../lib/control-tower';

const ago = (iso: string) => { const t = new Date(iso).getTime(); if (Number.isNaN(t)) return 'time not recorded'; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

function Shell({ id, title, sub, children }: { id: string; title: string; sub: string; children: React.ReactNode }) {
  return <section data-testid={id} aria-labelledby={`${id}-h`} className="min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-sm">
    <div className="ct-section-band border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3"><h2 id={`${id}-h`} className="text-sm font-semibold">{title}</h2><p className="break-words text-xs text-[var(--text-muted)]">{sub}</p></div>
    {children}
  </section>;
}
const Failed = ({ what, retry }: { what: string; retry?: () => void }) => <div role="alert" className="p-4 text-center text-sm"><p className="font-semibold">{what} unavailable</p><button type="button" onClick={retry} className="mt-2 min-h-10 rounded border border-[var(--border)] px-3 text-xs font-semibold">Retry</button></div>;

export function ActivityPanel({ title = 'Agent Activity', items, loading, failed, partialFailure, retry, updatedAt, coverage }: { title?: string; items: ActivityItem[]; loading?: boolean; failed?: boolean; partialFailure?: boolean; retry?: () => void; updatedAt?: Date | null; coverage: string }) {
  return <Shell id="activity-panel" title={title} sub={`Recorded events only — not verified outcomes. ${updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}.` : ''}`}>
    {loading ? <p role="status" className="p-4 text-xs">Loading recorded activity…</p> : failed ? <Failed what="Recorded activity" retry={retry} />
      : !items.length ? <p className="p-4 text-center text-sm text-[var(--text-muted)]">No recorded activity in available sources</p>
      : <ul className="m-0 list-none p-0">{items.slice(0, 8).map((i) => {
        const body = <div className="min-w-0 border-b border-[var(--border)] px-4 py-2.5">
          <p className="break-words text-sm font-semibold">{i.title}</p>
          <p className="line-clamp-2 break-words text-xs text-[var(--text-secondary)]">{i.detail}</p>
          <p className="break-words text-[11px] text-[var(--text-muted)]">{i.label} · {i.actor ? `recorded actor ${i.actor}` : 'actor not recorded'} · {i.createdAt ? ago(i.createdAt) : 'time not recorded'}</p></div>;
        return <li key={i.key} data-testid={`activity-${i.key}`}>{i.href ? <Link href={i.href} className="block hover:bg-[var(--surface-alt)]">{body}</Link> : body}</li>;
      })}</ul>}
    {partialFailure && !failed && <div role="alert" className="px-4 py-2 text-xs"><p>Activity coverage incomplete</p><button type="button" onClick={retry} className="mt-2 min-h-10 rounded border border-[var(--border)] px-3 font-semibold">Retry</button></div>}
    <p className="px-4 py-2 text-[11px] text-[var(--text-muted)]">{coverage}</p>
  </Shell>;
}

export function ReliabilityPanel({ data, loading, failed, retry, disclosures = [], updatedAt, offboardingSource }: { updatedAt?: Date | null; offboardingSource?: string; data: Reliability | null; loading?: boolean; failed?: boolean; retry?: () => void; disclosures?: SourceDisclosure[] }) {
  const capped = disclosures.filter((d) => d.capped);
  const row = (k: string, v: number, t: string) => <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0"><dt className="min-w-0 break-words text-xs text-[var(--text-secondary)]">{k}</dt><dd className="shrink-0 text-sm font-bold" data-testid={t}>{v}</dd></div>;
  return <Shell id="reliability-panel" title="Live Reliability Sources" sub="Counts from typed sources on live cases. Live quality: Not assessed. Fictional cases and simulations excluded.">
    {loading ? <p role="status" className="p-4 text-xs">Loading reliability sources…</p> : failed || !data ? <Failed what="Reliability sources" retry={retry} /> : <div className="grid grid-cols-1 gap-x-6 px-4 py-2 md:grid-cols-2">
      <dl className="m-0"><p className="text-[10px] font-bold uppercase text-[var(--text-muted)]">Technical</p>
        {row('Communication failed', data.technicalFailures, 'rel-failed')}{row('In progress / unknown effect (not a proven timeout)', data.unknownEffectManualRepair, 'rel-unknown')}
        {row('System check awaiting provider (not a failure)', data.systemChecksPending, 'rel-check-pending')}{row('System check overdue', data.systemChecksOverdue, 'rel-check-overdue')}{row('Recorded actions failed', data.failedActions, 'rel-actions-failed')}</dl>
      <dl className="m-0"><p className="text-[10px] font-bold uppercase text-[var(--text-muted)]">Not technical failures</p>
        {row('Policy blocks', data.policyBlocks, 'rel-policy')}{row('Waiting on a human', data.humanWaits, 'rel-human')}{row('Excluded (fictional or simulated)', data.excluded, 'rel-excluded')}</dl>
    </div>}
    {data && !data.provenanceKnown && <p role="status" className="px-4 pb-3 text-xs text-[var(--status-amber-fg)]" data-testid="rel-provenance">Case provenance is unavailable, so no live reliability claims are made.</p>}
    {data && data.items.length > 0 && <ul className="m-0 list-none border-t border-[var(--border)] p-0" data-testid="rel-items">{data.items.map((i) => <li key={i.key} className="border-b border-[var(--border)] last:border-0">
      <Link href={i.href} className="block min-w-0 px-4 py-2.5 hover:bg-[var(--surface-alt)]" data-testid={`rel-item-${i.key}`}>
        <p className="break-words text-sm font-semibold">{i.reference} · {i.title}</p>
        <p className="break-words text-xs text-[var(--text-secondary)]">{i.status} · {i.impact}</p>
        <p className="break-words text-[11px] text-[var(--text-muted)]">Source {i.source} · actor {i.actor} · owner {i.owner ?? 'not recorded'} · next: {i.nextStep}</p>
      </Link></li>)}</ul>}
    <p className="px-4 py-2 text-[11px] text-[var(--text-muted)]">Human corrections and fairness outcomes: Not assessed (no live source).</p>
    <p role="status" data-testid="rel-source" className="break-words px-4 pb-2 text-[11px] text-[var(--text-muted)]">
      Source: Action Center notifications, completed actions and approvals · {failed ? 'source failed' : 'available'} · {updatedAt ? `last successful update ${updatedAt.toLocaleTimeString()}` : 'no successful update yet'}
      {offboardingSource && offboardingSource !== 'available' ? ` · offboarding source ${offboardingSource} — coverage partial` : ''}
    </p>
    {capped.length > 0 && <p role="status" data-testid="truncation" className="break-words px-4 pb-3 text-[11px] text-[var(--status-amber-fg)]">Not complete: {capped.map((d) => `${d.label} ${d.shown} of ${d.available ?? 'unknown'}`).join('; ')}. Lists are bounded at 200.</p>}
  </Shell>;
}
