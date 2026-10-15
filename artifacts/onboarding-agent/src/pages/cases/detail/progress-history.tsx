import React, { useState } from 'react';
import { format } from 'date-fns';
import { EngineBadge } from '@/components/engine-badge';
import { Button } from '@/components/ui-shared';
import { lifecycleStageText } from '../../../lib/lifecycle-stage-presentation';
import { RestrictedActionNotice } from './case-access';

export const HISTORY_PAGE_SIZE = 10;
export type HistoryState = {
  events?: readonly any[];
  allowed: boolean;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  scope: string;
};

export function latestHistory(events: readonly any[]) {
  return [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || Number(b.id) - Number(a.id));
}

export function ProgressHistory(props: HistoryState) {
  // Expansion is local to the case AND its authorization scope.
  return <HistoryEntries key={props.scope} {...props} />;
}

function HistoryEntries({ events, allowed, loading, failed, retry }: HistoryState) {
  const [visible, setVisible] = useState(HISTORY_PAGE_SIZE);
  if (!allowed) return <RestrictedActionNotice>Recorded history is restricted by your current case and notes-read permissions.</RestrictedActionNotice>;
  if (failed) return <div role="alert" className="rounded-lg border p-4 text-sm">
    <p>Recorded history could not be loaded.</p>
    <Button type="button" variant="outline" className="mt-3" onClick={retry}>Retry history</Button>
  </div>;
  if (loading || !events) return <p role="status" aria-busy="true" className="p-4 text-sm">Loading recorded history...</p>;
  if (!events.length) return <p role="status" className="rounded-lg border p-4 text-sm text-[var(--text-muted)]">No recorded events yet.</p>;
  const sorted = latestHistory(events);
  const shown = sorted.slice(0, visible);
  const remaining = Math.max(0, sorted.length - visible);
  return <div className="min-w-0 rounded-lg border bg-[var(--surface)]">
    <p role="status" className="border-b p-4 text-xs text-[var(--text-muted)]">
      Showing {shown.length} of {sorted.length} recorded events · Latest first
    </p>
    <ol id="progress-history-events" className="divide-y divide-[var(--border)]">
      {shown.map(e => <li key={e.id} data-event-id={e.id} className="min-w-0 p-4 sm:p-5 [overflow-wrap:anywhere]">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <EngineBadge engine={e.engine} />
          <time dateTime={e.createdAt} className="text-xs font-mono text-[var(--text-muted)]">
            {format(new Date(e.createdAt), 'MMM d, yyyy HH:mm:ss')}
          </time>
        </div>
        <h3 className="text-sm font-bold">{lifecycleStageText(e.title)}</h3>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{lifecycleStageText(e.detail)}</p>
        {e.agent && <p className="mt-2 text-xs text-[var(--text-muted)]">Recorded by: {e.agent}</p>}
      </li>)}
    </ol>
    <div className="border-t p-4">
      <Button type="button" variant="outline" aria-controls="progress-history-events"
        disabled={!remaining} onClick={() => setVisible(n => n + HISTORY_PAGE_SIZE)}
        className="min-h-11 max-w-full whitespace-normal">
        {remaining ? `Show older events (${remaining} remaining)` : 'All recorded events shown'}
      </Button>
    </div>
  </div>;
}
