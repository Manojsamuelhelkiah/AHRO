import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import {
  useGetOnboardingDashboard, useListOnboardingCases, useGetOnboardingActionCenter, useGetControlTowerExamples,
  getGetOnboardingDashboardQueryKey, getListOnboardingCasesQueryKey, getGetOnboardingActionCenterQueryKey,
  getGetControlTowerExamplesQueryKey, getPinnedOrganizationIdForPage,
} from '@workspace/api-client-react';
import { useWorkforceScope } from '../components/workforce-insights/use-workforce-insights';

function opts<K extends readonly unknown[]>(key: K, enabled: boolean) {
  return { request: { headers: { 'x-organization-id': String(key[key.length - 3] ?? '') } },
    query: { enabled, queryKey: key as unknown as readonly unknown[], staleTime: 0, refetchInterval: 30_000, refetchOnMount: 'always' as const, refetchOnWindowFocus: true, retry: false } } as any;
}
export function useControlTower() {
  const { userId, sessionId } = useAuth();
  const queryClient = useQueryClient();
  const org = getPinnedOrganizationIdForPage();
  const scope = [org, userId, sessionId];
  const enabled = Boolean(org && userId && sessionId);
  const identity = JSON.stringify(scope);
  const last = useRef(identity);
  useEffect(() => {
    if (last.current === identity) return;
    last.current = identity;
    // Account, session or workspace transition: drop data disclosed to the previous principal.
    const bases = [getGetOnboardingDashboardQueryKey()[0], getListOnboardingCasesQueryKey()[0], getGetOnboardingActionCenterQueryKey()[0], getGetControlTowerExamplesQueryKey()[0]];
    queryClient.removeQueries({ predicate: (q) => (bases as string[]).includes(q.queryKey[0] as string) && JSON.stringify(q.queryKey.slice(-3)) !== identity });
  }, [identity, queryClient]);
  const dash = useGetOnboardingDashboard(opts([...getGetOnboardingDashboardQueryKey(), ...scope], enabled));
  const cases = useListOnboardingCases(opts([...getListOnboardingCasesQueryKey(), ...scope], enabled));
  const params = { scope: 'all' as const, limit: 200 };
  const actions = useGetOnboardingActionCenter(params, opts([...getGetOnboardingActionCenterQueryKey(params), ...scope], enabled));
  const examples = useGetControlTowerExamples(opts([...getGetControlTowerExamplesQueryKey(), ...scope], enabled));
  const reviews = useWorkforceScope();
  useEffect(() => {
    // React Query normally retains successful data after a refetch fails. This
    // overview must also remove it from the cache, not merely hide it in JSX.
    const states = [
      [dash.isError, [...getGetOnboardingDashboardQueryKey(), ...scope]],
      [cases.isError, [...getListOnboardingCasesQueryKey(), ...scope]],
      [actions.isError, [...getGetOnboardingActionCenterQueryKey(params), ...scope]],
      [examples.isError, [...getGetControlTowerExamplesQueryKey(), ...scope]],
    ] as const;
    for (const [failed, queryKey] of states) {
      const query = failed ? queryClient.getQueryCache().find({ queryKey, exact: true }) : undefined;
      if (query?.state.data !== undefined) query.setState({ data: undefined });
    }
  }, [dash.isError, cases.isError, actions.isError, examples.isError, identity, queryClient]);
  // Never retain a display after an error or denial.
  const clean = <T,>(q: { data?: T; isError: boolean; dataUpdatedAt: number }) => ({ data: q.isError ? undefined : q.data, updatedAt: q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null });
  return {
    dash, cases, actions, examples, reviews,
    dashData: clean(dash), casesData: clean(cases), actionsData: clean(actions), examplesData: clean(examples),
  };
}
