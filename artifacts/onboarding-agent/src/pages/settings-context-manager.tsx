import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useAuth } from '@clerk/react';
import {
  useListHroContextTransactions, getListHroContextTransactionsQueryKey,
  getPinnedOrganizationIdForPage,
  type ListHroContextTransactionsParams, HroContextWorkflow, type HroContextHistoryItem,
} from '@workspace/api-client-react';
import { Button, Card, CardContent, PageHeader } from '@/components/ui-shared';
import { CONTEXT_RETENTION_PATH, EXECUTION_HISTORY_PATH, correlationHistoryDestination } from '@/lib/context-history-navigation';

export function ExecutionHistoryPage() {
  return <div className="space-y-6 max-w-7xl mx-auto pb-12 min-w-0">
    <PageHeader title="Execution History" subtitle="Read-only execution metadata across all supported HRO workflows." />
    <ContextManagerHistoryViewer />
  </div>;
}

export function ContextManagerHistoryViewer() {
  const { userId } = useAuth();
  const organizationId = getPinnedOrganizationIdForPage();
  const search = useSearch();
  // Remount pagination state when the authenticated tenant/principal changes.
  return <ContextManagerHistory key={JSON.stringify([userId, organizationId, search])}
    userId={userId} organizationId={organizationId} search={search} />;
}

function ContextManagerHistory({ userId, organizationId, search }: {
  userId: string | null | undefined; organizationId: string | null; search: string;
}) {
  const [, navigate] = useLocation();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const filters = new URLSearchParams(search);
  const view = filters.get('contextView') === 'operator' ? 'operator' : 'personal';
  const workflow = (filters.get('contextWorkflow') || '') as HroContextWorkflow | '';
  const status = (filters.get('contextStatus') || '') as 'running' | 'completed' | 'failed' | '';
  const correlationId = filters.get('contextCorrelation') || '';
  const changeFilters = (changes: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    navigate(`${EXECUTION_HISTORY_PATH}${next.size ? `?${next}` : ''}`);
  };
  const params: ListHroContextTransactionsParams = {
    view, ...(workflow ? { workflow } : {}), ...(status ? { status } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(view === 'operator' && cursor ? { cursor } : {}),
  };
  const { data, isLoading, isError, refetch, isFetching } = useListHroContextTransactions(params, {
    query: {
      queryKey: [...getListHroContextTransactionsQueryKey(params), userId, organizationId],
      enabled: Boolean(userId), staleTime: 0, gcTime: 0, retry: false,
      // New arrivals must not move the seek position on an older page.
      refetchInterval: cursor ? false : 30_000,
    },
  });
  if (!userId) return null;
  return (
    <Card id="execution-history" data-testid="execution-history">
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">HRO execution attempts</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {view === 'operator' ? 'Organization attempts, including background work, in pages of up to 30.' :
                'Your latest 30 matching execution attempts in this organization.'} Context links requests,
              agents and workflow checkpoints; it does not grant access or replace live policy checks.
            </p>
          </div>
          <Button variant="outline" className="shrink-0 min-h-11" disabled={isFetching}
            onClick={() => { if (cursor) setCursors([]); else void refetch(); }}>
            {cursor ? 'Refresh latest' : 'Refresh'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Metadata only: no prompts, answers, documents or contact details. A completed attempt
          does not mean a business workflow is complete. Running means no final result
          has been recorded, including interrupted attempts. Each entry shows its latest 20 steps.
          Confirmed failure means the attempt recorded an error, not that all provider effects failed.
          This read-only view cannot retry business workflows or replay provider actions.
        </p>
        <Link href={CONTEXT_RETENTION_PATH} className="inline-block underline text-sm min-h-11 py-3">Context metadata retention settings</Link>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 items-end">
          <label className="text-xs space-y-1 min-w-0">History view
            <select aria-label="History view" className="block w-full min-w-0 rounded border bg-background p-2 min-h-11"
              value={view} onChange={event => changeFilters({ contextView: event.target.value, contextCorrelation: '' })}>
              <option value="personal">My attempts</option>
              {(data?.operatorAvailable || view === 'operator') && <option value="operator">Operator — organization metadata</option>}
            </select>
          </label>
          <label className="text-xs space-y-1 min-w-0">Workflow
            <select aria-label="Workflow" className="block w-full min-w-0 rounded border bg-background p-2 min-h-11"
              value={workflow} onChange={event => changeFilters({ contextWorkflow: event.target.value })}>
              <option value="">All workflows</option>
              {Object.values(HroContextWorkflow).map(value => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}
            </select>
          </label>
          <label className="text-xs space-y-1 min-w-0">Status
            <select aria-label="Status" className="block w-full min-w-0 rounded border bg-background p-2 min-h-11"
              value={status} onChange={event => changeFilters({ contextStatus: event.target.value })}>
              <option value="">All statuses</option>
              <option value="running">Unfinished (no final result)</option>
              <option value="completed">Completed attempt</option>
              <option value="failed">Confirmed failed attempt</option>
            </select>
          </label>
        </div>
        {correlationId && <div className="space-y-2 min-w-0">
          <p className="text-xs break-all">Correlation filter: {correlationId}</p>
          <Button variant="outline" className="min-h-11" onClick={() => changeFilters({ contextCorrelation: '' })}>Clear correlation filter</Button>
        </div>}
        {view === 'operator' && <p className="text-xs text-muted-foreground">
          Requires a live data.context.metadata.read grant. Organization roles alone do not grant this
          access, and this permission does not unlock business evidence or specialist decisions.
        </p>}
        {isLoading ? <p role="status" className="text-sm">Loading execution history…</p> :
          isError ? <p role="alert" className="text-sm text-destructive">
            Execution history is unavailable. Operator access may have been revoked or the filters may be invalid.
            Choose My attempts or use Refresh to try again.
          </p> :
          data?.available === false ? <p className="text-sm">Personal execution history is unavailable for shared demo logins.</p> :
          !data?.transactions.length ? <p className="text-sm text-muted-foreground">No execution attempts match this view and its filters.</p> :
          <ContextTransactionList transactions={data.transactions} view={view} />}
        {view === 'operator' && <ContextHistoryPagination page={cursors.length + 1}
          hasOlder={!isError && Boolean(data?.nextCursor)} busy={isFetching}
          onNewer={() => setCursors(previous => previous.slice(0, -1))}
          onOlder={() => { if (!isError && data?.nextCursor) setCursors(previous => [...previous, data.nextCursor!]); }} />}
      </CardContent>
    </Card>
  );
}

export function ContextHistoryPagination({ page, hasOlder, busy, onNewer, onOlder }: {
  page: number; hasOlder: boolean; busy: boolean; onNewer: () => void; onOlder: () => void;
}) {
  return <nav aria-label="Execution history pages" className="flex flex-wrap gap-3 items-center">
    <Button variant="outline" disabled={busy || page === 1} onClick={onNewer}>Newer attempts</Button>
    <span role="status" className="text-xs text-muted-foreground">Page {page} · up to 30 attempts</span>
    <Button variant="outline" disabled={busy || !hasOlder} onClick={onOlder}>Older attempts</Button>
  </nav>;
}

/** Metadata-only rendering; correlation links return to this same permission boundary. */
export function ContextTransactionList({ transactions, view }: {
  transactions: HroContextHistoryItem[]; view: 'personal' | 'operator';
}) {
  return <div className="space-y-3">
            {transactions.map(transaction => (
              <details key={transaction.id} className="rounded-lg border p-3 sm:p-4 min-w-0">
                <summary className="cursor-pointer min-h-11 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium capitalize">{transaction.workflow.replaceAll('-', ' ')}</span>
                  <span className={transaction.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                    {transaction.status === 'running' ? 'Unfinished — no final result' :
                      transaction.status === 'failed' ? 'Confirmed failed attempt' : 'Completed attempt'}
                  </span>
                  <span className="text-xs text-muted-foreground">{new Date(transaction.startedAt).toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">
                    Started {Math.floor(transaction.ageSeconds / 60)} minutes ago · {transaction.initiatorType}-initiated
                  </span>
                </summary>
                <dl className="text-xs space-y-2 mt-3 break-all">
                  <div><dt className="font-medium">Transaction</dt><dd>{transaction.id}</dd></div>
                  <div><dt className="font-medium">Continuity anchor</dt><dd>{transaction.anchorId}</dd></div>
                  <div><dt className="font-medium">Correlation</dt><dd>
                    <Link className="underline" href={correlationHistoryDestination(view, transaction.correlationId)}>
                      {transaction.correlationId} — view related attempts
                    </Link>
                  </dd></div>
                  {transaction.parentTransactionId && <div><dt className="font-medium">Parent attempt</dt><dd>{transaction.parentTransactionId}</dd></div>}
                  <div><dt className="font-medium">Executor / revision</dt><dd>{transaction.executorType} / {transaction.version}</dd></div>
                </dl>
                <ul className="mt-3 space-y-2 text-xs">
                  {transaction.steps.map((step, index) => <li key={index} className="flex flex-wrap gap-2">
                    <span>{step.code.replaceAll('-', ' ')}</span>
                    {step.inputBytes !== undefined && <span className="text-muted-foreground">Input bound: {step.inputBytes} bytes</span>}
                    {step.outputTokens !== undefined && <span className="text-muted-foreground">Output budget: {step.outputTokens} tokens</span>}
                  </li>)}
                </ul>
                {!transaction.steps.length && <p className="text-xs text-muted-foreground mt-3">No boundary steps recorded.</p>}
              </details>
            ))}
          </div>;
}
