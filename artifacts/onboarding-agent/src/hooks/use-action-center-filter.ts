import { useSearch } from "wouter";
import { useAuth } from "@clerk/react";
import { getPinnedOrganizationIdForPage, getGetOnboardingActionCenterQueryKey,
  useGetOnboardingActionCenter, type ActionCenterCaseType, type GetOnboardingActionCenterParams } from "@workspace/api-client-react";
import { actionCenterTypeFromSearch } from "../lib/action-center-filter";

export function useActionCenterCaseType(): ActionCenterCaseType | undefined {
  return actionCenterTypeFromSearch(useSearch());
}
export function useActionCenterScope() {
  const { userId, sessionId } = useAuth();
  return [getPinnedOrganizationIdForPage(), userId, sessionId];
}
export function useActionCenter(params: GetOnboardingActionCenterParams) {
  const caseType = useActionCenterCaseType();
  const scope = useActionCenterScope();
  const input = { ...params, caseType };
  const query = useGetOnboardingActionCenter(input, { query: {
    queryKey: [...getGetOnboardingActionCenterQueryKey(input), ...scope],
    staleTime: 0, refetchInterval: 30_000, retry: false,
  } });
  // Never retain previously disclosed records following a denied refresh.
  return { ...query, data: query.isError ? undefined : query.data };
}
