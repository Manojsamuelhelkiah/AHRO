import type { WorkforceInsights } from '@workspace/api-client-react';
import { isLive } from './parts';

/** Read-only discovery: each persisted review contributes once, not once per kind or source. */
export function pendingActionReviews(data: WorkforceInsights | undefined) {
  const seen = new Set<string>();
  return (data?.reviews ?? []).filter(review => {
    if (!isLive(review) || seen.has(review.id)) return false;
    seen.add(review.id);
    return true;
  }).sort((a, b) => Number(b.priority === 'critical') - Number(a.priority === 'critical') ||
    a.dueDate.localeCompare(b.dueDate) || a.reference.localeCompare(b.reference));
}
