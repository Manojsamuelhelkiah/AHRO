import { Link } from 'wouter';
import type { ControlTowerExample, ControlTowerExamples } from '@workspace/api-client-react';
import { examplesAggregate, exampleDetailHref } from '../../lib/control-tower';

const LABEL: Record<string, string> = { 'integration-failure': 'Integration failure', 'ambiguous-timeout': 'Ambiguous timeout', 'stale-update': 'Stale update', 'stuck-task': 'Stuck task', 'answer-match': 'Answer match', 'human-correction': 'Human correction', 'fairness-review': 'Fairness review' };

export function ExampleDetail({ example }: { example: ControlTowerExample }) {
  const row = (k: string, v: string | null) => v ? <div className="min-w-0"><dt className="text-[10px] font-bold uppercase text-[var(--text-muted)]">{k}</dt><dd className="break-words text-xs text-[var(--text-secondary)]">{v}</dd></div> : null;
  return <div className="space-y-2">
    <p className="break-words text-sm font-semibold">{example.title}</p>
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {row('Category', LABEL[example.category])}{row('Agent', example.agent)}{row('Source', example.source)}{row('Task', example.task)}
      {row('Status', example.status)}{row('Impact', example.impact)}{row('Owner', example.owner ?? 'Not recorded')}{row('Next step', example.nextStep)}
      {row('Expected', example.expected)}{row('Observed', example.observed)}{row('Corrected', example.corrected)}
      {example.matched !== null && row('Matched', example.matched ? 'Yes' : 'No')}
    </dl>
    <p className="break-words text-[11px] text-[var(--text-muted)]">Limitations: {example.limitations}</p>
  </div>;
}

export function ExamplesSection({ data, loading, failed, retry, updatedAt }: { data?: ControlTowerExamples; loading?: boolean; failed?: boolean; retry?: () => void; updatedAt?: Date | null }) {
  const agg = examplesAggregate(data);
  return <section data-testid="control-tower-examples" aria-labelledby="ct-examples" className="min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-sm">
    <div className="ct-section-band border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3">
      <h2 id="ct-examples" className="text-sm font-semibold">Operational reliability examples</h2>
      <p className="text-xs text-[var(--text-muted)]">Authored fictional examples — separate from live measurement. Live quality: Not assessed.{updatedAt ? ` Updated ${updatedAt.toLocaleTimeString()}.` : ''}</p>
    </div>
    {loading ? <p role="status" className="p-4 text-xs">Loading examples…</p>
      : failed || !data ? <div role="alert" className="p-4 text-center text-sm">Examples unavailable. <button type="button" className="font-semibold text-[var(--primary)] underline" onClick={retry}>Retry</button></div>
      : <>
        <p data-testid="examples-aggregate" className="px-4 pt-3 text-xs">{agg!.shown} of {agg!.inventory} authored examples available to you. {agg!.note} Fairness examples show expectations and limitations only, not certification.</p>
        {data.items.length === 0 ? <p className="p-4 text-sm text-[var(--text-muted)]">No authorized examples are available.</p> :
          <ul className="m-0 list-none p-0">{data.items.map((e) => <li key={e.id} className="border-t border-[var(--border)] first:border-t-0">
            <Link href={exampleDetailHref(e.caseHref)} className="block px-4 py-2.5 hover:bg-[var(--surface-alt)]" data-testid={`example-link-${e.id}`}>
              <p className="break-words text-sm font-semibold">{e.reference} · {LABEL[e.category]}</p>
              <p className="line-clamp-2 break-words text-xs text-[var(--text-secondary)]">{e.title} — {e.status}</p>
              <p className="text-[11px] text-[var(--text-muted)]">{e.family} · {e.owner ?? 'No owner recorded'} · View detail</p>
            </Link></li>)}</ul>}
      </>}
  </section>;
}

import { useGetControlTowerExamples, getGetControlTowerExamplesQueryKey, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useAuth } from '@clerk/react';

/** Read-only example detail on the ordinary case page. Renders nothing when the case has no example. */
export function CaseExampleSection({ caseId }: { caseId: number }) {
  const { userId, sessionId } = useAuth();
  const q = useGetControlTowerExamples({ query: { queryKey: [...getGetControlTowerExamplesQueryKey(), getPinnedOrganizationIdForPage(), userId, sessionId], refetchInterval: 30_000, retry: false } as any });
  const requested = typeof window !== 'undefined' && window.location.hash === '#operational-reliability';
  if (q.isError && requested) return <section id="operational-reliability" role="alert" className="my-4 rounded-lg border border-[var(--border)] p-4 text-sm" data-testid="case-example-error">
    <p className="font-semibold">Operational reliability example could not be loaded.</p>
    <button type="button" onClick={() => void q.refetch()} className="mt-2 min-h-10 rounded border border-[var(--border)] px-3 text-xs font-semibold">Retry</button></section>;
  if (q.isLoading && requested) return <section id="operational-reliability" role="status" className="my-4 p-4 text-xs">Loading operational reliability example…</section>;
  const mine = q.isError ? [] : (q.data?.items ?? []).filter((e) => e.caseId === caseId);
  if (!mine.length) return null;
  return <section id="operational-reliability" className="my-4 scroll-mt-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="case-example-detail">
    <h2 className="text-sm font-semibold">Operational reliability example</h2>
    <p className="mb-2 text-xs text-[var(--text-muted)]">Authored example · read-only · not production measurement.</p>
    {mine.map((e) => <ExampleDetail key={e.id} example={e} />)}
  </section>;
}
