export const EXECUTION_HISTORY_PATH = '/execution-history';
export const CONTEXT_RETENTION_PATH = '/settings#context-metadata-retention';

export function legacyContextHistoryDestination(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (hash !== '#unified-context-manager' &&
      !['contextView', 'contextCorrelation', 'contextWorkflow', 'contextStatus'].some(key => params.has(key))) return null;
  return `${EXECUTION_HISTORY_PATH}${params.size ? `?${params}` : ''}`;
}

export function correlationHistoryDestination(view: 'personal' | 'operator', correlationId: string): string {
  return `${EXECUTION_HISTORY_PATH}?${new URLSearchParams({ contextView: view, contextCorrelation: correlationId })}`;
}
