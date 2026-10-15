import { useEffect, useRef } from 'react';
import { Card } from '@/components/ui-shared';
import { ErrorNote, Skeleton, useEmailReadiness, useEmailScope, useClearDeniedEmailData } from '../email-intake/common';
import { ReviewTurnaround } from '../email-intake/turnaround';

/** Independent of case analytics filters, failures, and permissions. */
export function EmailTurnaroundReport() {
  const { org, scope } = useEmailScope();
  const query = useEmailReadiness();
  const target = useRef<HTMLElement>(null);
  useClearDeniedEmailData(query.error);
  useEffect(() => {
    if (window.location.hash === '#human-review-turnaround') target.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  return (
    <section ref={target} id="human-review-turnaround" aria-label="Email intake human review turnaround" className="mb-10 min-w-0 scroll-mt-6">
      {!org ? <Card className="p-4">Select a client to view human review turnaround.</Card>
        : query.isError ? <Card className="space-y-3 p-4"><h2 className="text-base font-semibold">Human review turnaround</h2><ErrorNote error={query.error} onRetry={() => query.refetch()} /></Card>
        : !query.isFetchedAfterMount || !query.data ? <Skeleton n={2} />
        : <ReviewTurnaround key={scope} data={query.data.turnaround} />}
    </section>
  );
}
