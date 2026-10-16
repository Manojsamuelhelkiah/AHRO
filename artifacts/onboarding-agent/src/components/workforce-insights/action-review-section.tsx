import type { WorkforceInsights } from '@workspace/api-client-react';
import { KIND_LABEL, PriorityBadge, ReviewLinks, ReviewStatusBadge } from './parts';
import { pendingActionReviews } from './action-review-projection';

export function ActionReviewSection({ data, failed, denied, refreshing, retry }: {
  data?: WorkforceInsights; failed: boolean; denied: boolean; refreshing: boolean; retry: () => void;
}) {
  const reviews = pendingActionReviews(data);
  return <section aria-labelledby="action-reviews-heading" className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3" data-testid="action-early-warning-reviews">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="action-reviews-heading" className="text-sm font-semibold">Early-warning human reviews {data ? `(${reviews.length})` : ''}</h3>
      {refreshing && data && <span role="status" className="text-xs text-[var(--text-muted)]">Updating reviews…</span>}
    </div>
    <p className="mt-1 text-xs text-[var(--text-muted)]">Human follow-up priorities, not model risk scores. Review details and history remain in Analytics.</p>
    {failed ? <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span>{denied ? 'Early-warning reviews are unavailable. Current administrator and source-case access are required.' : 'Early-warning reviews could not be loaded. No cached reviews are shown.'}</span>
      <button onClick={retry} className="min-h-11 px-3 font-semibold text-[var(--primary)] underline">Retry reviews</button>
    </div> : !data ? <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">Loading early-warning reviews…</p>
      : reviews.length === 0 ? <p className="mt-3 text-sm text-[var(--text-muted)]">No pending early-warning reviews match these filters.</p>
      : <ul className="mt-2 divide-y divide-[var(--border)]">
        {reviews.map(review => <li key={review.id} data-testid={`action-review-${review.id}`} className="min-w-0 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs font-bold">{review.reference}</span>
            <span className="text-xs">{KIND_LABEL[review.kind]}</span>
            <PriorityBadge priority={review.priority} /><ReviewStatusBadge status={review.status} />
          </div>
          <div className="mt-2 flex min-w-0 flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="min-w-0 break-words text-[var(--text-secondary)]">Owner: {data.owners.find(owner => owner.userId === review.ownerUserId)?.label ?? review.ownerUserId} · Due <time dateTime={review.dueDate}>{review.dueDate.slice(0, 10)}</time></p>
            <ReviewLinks review={review} />
          </div>
        </li>)}
      </ul>}
  </section>;
}
