import { useListHroContextTransactions, getListHroContextTransactionsQueryKey } from '@workspace/api-client-react';
import { Button, Card, CardContent } from '@/components/ui-shared';

export function ContextManagerSettingsCard() {
  const { data, isLoading, isError, refetch, isFetching } = useListHroContextTransactions({
    query: { queryKey: getListHroContextTransactionsQueryKey(), staleTime: 10_000, refetchInterval: 30_000 },
  });
  return (
    <Card data-testid="unified-context-manager">
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Unified context manager</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Your latest 30 execution attempts in this organization. Context links requests,
              agents and workflow checkpoints; it does not grant access or replace live policy checks.
            </p>
          </div>
          <Button variant="outline" className="shrink-0 min-h-11" disabled={isFetching} onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Metadata only: no prompts, answers, documents or contact details. A completed attempt
          does not mean a hire or business workflow is complete. Running means no final result
          has been recorded, including interrupted attempts. Each entry shows its latest 20 steps.
        </p>
        {isLoading ? <p role="status" className="text-sm">Loading execution history…</p> :
          isError ? <p role="alert" className="text-sm text-destructive">Execution history could not be loaded. Use Refresh to try again.</p> :
          data?.available === false ? <p className="text-sm">Personal execution history is unavailable for shared demo logins.</p> :
          !data?.transactions.length ? <p className="text-sm text-muted-foreground">No execution attempts recorded for you yet.</p> :
          <div className="space-y-3">
            {data.transactions.map(transaction => (
              <details key={transaction.id} className="rounded-lg border p-3 sm:p-4 min-w-0">
                <summary className="cursor-pointer min-h-11 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium capitalize">{transaction.workflow.replaceAll('-', ' ')}</span>
                  <span className={transaction.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                    {transaction.status === 'running' ? 'Running / unfinished' : transaction.status}
                  </span>
                  <span className="text-xs text-muted-foreground">{new Date(transaction.startedAt).toLocaleString()}</span>
                </summary>
                <dl className="text-xs space-y-2 mt-3 break-all">
                  <div><dt className="font-medium">Transaction</dt><dd>{transaction.id}</dd></div>
                  <div><dt className="font-medium">Continuity anchor</dt><dd>{transaction.anchorId}</dd></div>
                  <div><dt className="font-medium">Correlation</dt><dd>{transaction.correlationId}</dd></div>
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
          </div>}
      </CardContent>
    </Card>
  );
}
