import { Link } from 'wouter';
import { useWorkforceScope } from './use-workforce-insights';
import { KIND_LABEL, PriorityBadge, ReviewLinks, ReviewStatusBadge, isLive } from './parts';

/** Compact list of real, persisted human early-warning reviews. Hidden when unavailable to the viewer. */
export function WorkforceReviewPanel({ limit = 5 }: { limit?: number }) {
  const { data, denied, failed, query, organizationId } = useWorkforceScope();
  if (!organizationId || denied) return null;
  const wrap = 'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]';
  if (failed) return <div className={`${wrap} p-3 text-[12px] text-[var(--text-muted)]`}>Early-warning reviews could not be loaded. <button className="min-h-10 px-2 underline" onClick={() => void query.refetch()}>Retry</button></div>;
  if (!data) return <div className={`${wrap} h-16 animate-pulse`} aria-busy="true" />;
  const live = data.reviews.filter(isLive).sort((a, b) => Number(b.priority === 'critical') - Number(a.priority === 'critical') || a.dueDate.localeCompare(b.dueDate));
  const critical = live.filter((r) => r.priority === 'critical').length;
  return (
    <section className={wrap} aria-label="Early-warning human reviews" data-testid="panel-workforce-reviews">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
        <h2 className="m-0 text-[13px] font-semibold">Early-warning human reviews <span className="font-normal text-[var(--text-muted)]">({live.length} open{critical ? `, ${critical} critical` : ''})</span></h2>
        <Link href="/analytics#early-warning" className="text-[12px] font-semibold text-[var(--primary)] hover:underline">Open in Analytics</Link>
      </div>
      {live.length === 0 ? <p className="m-0 p-3 text-[12px] text-[var(--text-muted)]">No open human reviews. These are separate from onboarding case workflows.</p> : (
        <ul className="m-0 list-none p-0">{live.slice(0, limit).map((r) => (
          <li key={r.id} className="border-b border-[var(--border)] px-3 py-2 last:border-0" data-testid={`row-workforce-review-${r.id}`}>
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[12px] font-bold">{r.reference}</span><ReviewStatusBadge status={r.status} /><PriorityBadge priority={r.priority} /><span className="text-[12px] text-[var(--text-secondary)]">{KIND_LABEL[r.kind]}</span></div>
            <p className="my-1 line-clamp-2 text-[12px] text-[var(--text-secondary)]">{r.reason}</p>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-[var(--text-muted)]">Due {r.dueDate.slice(0, 10)}</span><ReviewLinks review={r} /></div>
          </li>))}</ul>)}
      {live.length > limit && <div className="px-3 py-2 text-[12px]"><Link href="/analytics#early-warning" className="font-semibold text-[var(--primary)] hover:underline">{live.length - limit} more in Analytics</Link></div>}
    </section>
  );
}
