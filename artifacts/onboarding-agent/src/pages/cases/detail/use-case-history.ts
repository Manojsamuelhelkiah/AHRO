import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListOnboardingCaseEvents, getListOnboardingCaseEventsQueryKey } from '@workspace/api-client-react';
import type { CaseAccessPermissions } from './case-access';

/** Never reuse notes across a principal, case, or permission generation. */
export function useCaseHistory(caseId: number, organization: string, user: string,
  permissions: CaseAccessPermissions | undefined, permissionsFailed: boolean, status?: string) {
  const qc = useQueryClient();
  const signature = JSON.stringify(permissions);
  const allowed = caseId > 0 && permissions?.caseId === caseId && !permissionsFailed
    && permissions.access.flowRead === true && permissions.access.notesRead === true;
  const queryKey = useMemo(() => [...getListOnboardingCaseEventsQueryKey(caseId),
    'progress-history', organization, user, signature], [caseId, organization, user, signature]);
  const query = useListOnboardingCaseEvents(caseId, {
    query: {
      queryKey, enabled: allowed, retry: false, gcTime: 0, placeholderData: undefined,
      refetchOnWindowFocus: 'always',
      refetchInterval: ['running', 'waiting-approval', 'blocked', 'checklist-blocked', 'idle'].includes(status || '')
        ? 2500 : false,
    },
  });
  useEffect(() => () => {
    // Cancellation fences late responses too; removing a disabled cache alone
    // would not prevent an in-flight request from restoring it.
    void qc.cancelQueries({ queryKey, exact: true });
    qc.removeQueries({ queryKey, exact: true });
  }, [qc, queryKey]);
  return {
    events: allowed && !query.isError ? query.data : undefined,
    allowed,
    loading: allowed && query.isPending,
    failed: allowed && query.isError,
    retry: () => { if (allowed) void query.refetch(); },
    scope: JSON.stringify(queryKey),
  };
}
