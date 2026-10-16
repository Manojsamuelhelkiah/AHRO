import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import {
  useGetWorkforceInsights,
  useCreateWorkforceReviewCase,
  useUpdateWorkforceReviewCase,
  getGetWorkforceInsightsQueryKey,
  getListOnboardingCasesQueryKey,
  getPinnedOrganizationIdForPage,
} from '@workspace/api-client-react';
import type { WorkforceInsights, GetWorkforceInsightsParams } from '@workspace/api-client-react';

export function workforceScopedKey(organizationId: string | null, userId?: string | null, sessionId?: string | null, filters?: GetWorkforceInsightsParams) {
  return [...getGetWorkforceInsightsQueryKey(), organizationId, userId, sessionId, filters] as const;
}

export function errorStatus(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

export function mutationMessage(e: unknown): string {
  const status = errorStatus(e);
  if (status === 409) return 'This review changed since you loaded it. Reload the latest data and try again; nothing was saved.';
  if (status === 403) return 'You do not have permission to manage reviews.';
  return (e as Error)?.message || 'The request failed. Nothing was saved.';
}

/** Client/account/session-scoped reviews. Never exposes cached data after errors or scope changes. */
export function useWorkforceScope(filters?: GetWorkforceInsightsParams) {
  const queryClient = useQueryClient();
  const { userId, sessionId } = useAuth();
  const organizationId = getPinnedOrganizationIdForPage();
  const headers = useMemo(() => { const h: Record<string, string> = {}; if (organizationId) h['x-organization-id'] = organizationId; return h; }, [organizationId]);
  const key = workforceScopedKey(organizationId, userId, sessionId, filters);

  // Account and session transitions must not reuse another principal's disclosure.
  const identity = JSON.stringify([organizationId, userId, sessionId]);
  const lastScope = useRef(identity);
  useEffect(() => {
    if (lastScope.current !== identity) {
      lastScope.current = identity;
      queryClient.removeQueries({ queryKey: getGetWorkforceInsightsQueryKey(), predicate: (q) =>
        q.queryKey[1] !== organizationId || q.queryKey[2] !== userId || q.queryKey[3] !== sessionId });
    }
  }, [identity, organizationId, userId, sessionId, queryClient]);

  const query = useGetWorkforceInsights(filters, {
    request: { headers },
    query: { queryKey: key as unknown as readonly unknown[] as never, enabled: Boolean(organizationId), retry: false, refetchInterval: 30_000, staleTime: 0, refetchOnMount: 'always' },
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetWorkforceInsightsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
  };
  const create = useCreateWorkforceReviewCase({ request: { headers }, mutation: { retry: false, onSuccess: invalidateAll } });
  const update = useUpdateWorkforceReviewCase({ request: { headers }, mutation: { retry: false, onSuccess: invalidateAll } });

  const denied = errorStatus(query.error) === 403;
  const failed = query.isError;
  const data: WorkforceInsights | undefined = !failed && query.data && query.data.organizationId === organizationId ? query.data : undefined;
  return { organizationId, query, data, denied, failed, create, update };
}
