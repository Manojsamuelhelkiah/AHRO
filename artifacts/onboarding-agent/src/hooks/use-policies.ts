import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/react';
import { customFetch, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';

export type PolicyMembershipRole = 'owner' | 'admin' | 'member';
export type PolicyVersionStatus = 'draft' | 'in_review' | 'published' | 'superseded' | 'retired';
export type PolicyReviewAuthorityRole = 'hr-compliance' | 'legal' | 'occupational-health' | 'payroll';
export type PolicyApplicability = Partial<Record<'country' | 'workerType' | 'location', string>>;

export interface PolicyVersion {
  policyId: string;
  version: number;
  title: string;
  sourceReference: string;
  audience: PolicyMembershipRole[];
  applicability: PolicyApplicability;
  effectiveFrom: string;
  effectiveUntil: string | null;
  reviewBy: string | null;
  status: PolicyVersionStatus;
  reviewAuthorityRole: PolicyReviewAuthorityRole;
  createdByUserId: string;
  reviewedByUserId: string | null;
  reviewOutcome: 'approved' | 'rejected' | null;
  reviewerVerificationReference: string | null;
  publishedAt: string | null;
  publisherUserId: string | null;
  publicationVerificationReference: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDetail {
  policy: PolicyVersion;
  text: string;
}

export interface PolicyReminder {
  id: number;
  policyId: string;
  version: number;
  title: string;
  kind: 'review_due' | 'effective_end';
  dueOn: string;
  daysRemaining: number;
  createdAt: string;
}

export interface PolicyCapabilities {
  membershipRole: PolicyMembershipRole;
  canMaintain: boolean;
  canReview: boolean;
  canPublish: boolean;
  reviewAuthorityRoles: Array<{ role: PolicyReviewAuthorityRole; current: boolean }>;
  canReviewHistory: boolean;
  canResolveHandoffs: boolean;
  answerMode: 'approved-ai-only';
  externalDispatch: false;
}

export interface PolicyInput {
  title: string;
  sourceReference: string;
  text: string;
  audience: PolicyMembershipRole[];
  applicability?: PolicyApplicability;
  reviewAuthorityRole?: PolicyReviewAuthorityRole;
  effectiveFrom: string;
  effectiveUntil?: string;
  reviewBy?: string;
}

export interface PolicyHandoff {
  id: number;
  organizationId: string;
  requesterUserId: string;
  fingerprint: string;
  question: string;
  appliesOn: string | null;
  applicability: PolicyApplicability;
  status: 'open' | 'resolved';
  resolution: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

type Scope = { organizationId: string | null; userId: string | null };

/**
 * customFetch reads the immutable page-pinned organization when dispatching.
 * We only read it for cache isolation; never substitute mutable localStorage.
 */
function currentScope(userId: string | null | undefined): Scope {
  return { organizationId: getPinnedOrganizationIdForPage(), userId: userId ?? null };
}

export function usePolicyScope(): Scope {
  const { user } = useUser();
  return currentScope(user?.id);
}

export const getPoliciesKey = (scope: Scope) => ['hr-policies', scope.organizationId, scope.userId] as const;
export const getHandoffsKey = (scope: Scope) => ['hr-policy-handoffs', scope.organizationId, scope.userId] as const;

function policyQueryOptions(scope: Scope) {
  return {
    enabled: Boolean(scope.organizationId && scope.userId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
  };
}

function invalidatePolicyData(queryClient: ReturnType<typeof useQueryClient>, scope: Scope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getPoliciesKey(scope) }),
    queryClient.invalidateQueries({ queryKey: getHandoffsKey(scope) }),
  ]);
}

const request = <T,>(url: string, init: RequestInit = {}) =>
  customFetch<T>(url, { credentials: 'include', responseType: 'json', ...init });

export function usePolicyCapabilities() {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: [...getPoliciesKey(scope), 'capabilities'],
    queryFn: () => request<PolicyCapabilities>('/api/policies/capabilities'),
    ...policyQueryOptions(scope),
    refetchInterval: 15_000,
  });
}

export function usePolicies() {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: getPoliciesKey(scope),
    queryFn: async () => (await request<{ policies: PolicyVersion[] }>('/api/policies')).policies,
    ...policyQueryOptions(scope),
    refetchInterval: 15_000,
  });
}

export function usePolicyReminders(enabled: boolean) {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: [...getPoliciesKey(scope), 'reminders'],
    queryFn: () => request<PolicyReminder[]>('/api/policies/reminders'),
    ...policyQueryOptions(scope),
    enabled: Boolean(enabled && scope.organizationId && scope.userId),
    refetchInterval: 15_000,
  });
}

export function usePolicyHistory(policyId: string) {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: [...getPoliciesKey(scope), policyId, 'history'],
    queryFn: async () => (await request<{ policies: PolicyVersion[] }>(`/api/policies/${policyId}/history`)).policies,
    ...policyQueryOptions(scope),
    enabled: Boolean(policyId && scope.organizationId && scope.userId),
  });
}

export function usePolicyVersion(policyId: string, version: number | null) {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: [...getPoliciesKey(scope), policyId, version, 'version'],
    queryFn: () => request<PolicyDetail>(`/api/policies/${policyId}/versions/${version}`),
    ...policyQueryOptions(scope),
    enabled: Boolean(policyId && version && scope.organizationId && scope.userId),
  });
}

function usePolicyMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  const scope = usePolicyScope();
  return useMutation({
    mutationFn,
    retry: false,
    onSuccess: () => {
      // A persisted receipt must reach the caller even if an unrelated list
      // refresh is slow. Query errors remain visible in their own views.
      void invalidatePolicyData(queryClient, scope);
    },
  });
}

export function useCreatePolicy() {
  return usePolicyMutation<PolicyInput, { policy: PolicyVersion }>((data) =>
    request('/api/policies', { method: 'POST', body: JSON.stringify(data) }));
}

export function useUpdateDraft(policyId: string) {
  return usePolicyMutation<PolicyInput & { expectedVersion: number }, { policy: PolicyVersion }>((data) =>
    request(`/api/policies/${policyId}/draft`, { method: 'PATCH', body: JSON.stringify(data) }));
}

export function useSubmitReview(policyId: string) {
  return usePolicyMutation<{ expectedVersion: number }, { policy: PolicyVersion }>((data) =>
    request(`/api/policies/${policyId}/submit-review`, { method: 'POST', body: JSON.stringify(data) }));
}

export function useReviewPolicy(policyId: string) {
  return usePolicyMutation<
    { version: number; outcome: 'approved' | 'rejected'; verificationReference: string },
    { policy: PolicyVersion }
  >((data) => request(`/api/policies/${policyId}/reviews`, { method: 'POST', body: JSON.stringify(data) }));
}

export function usePublishPolicy(policyId: string) {
  return usePolicyMutation<{ expectedVersion: number; publicationVerificationReference: string }, { policy: PolicyVersion }>((data) =>
    request(`/api/policies/${policyId}/publish`, { method: 'POST', body: JSON.stringify(data) }));
}

export function useSupersedePolicy(policyId: string) {
  return usePolicyMutation<{ version: number; replacementVersion: number }, { policy: PolicyVersion }>((data) =>
    request(`/api/policies/${policyId}/supersede`, { method: 'POST', body: JSON.stringify(data) }));
}

export function useRetirePolicy(policyId: string) {
  return usePolicyMutation<{ version: number }, { policy: PolicyVersion }>((data) =>
    request(`/api/policies/${policyId}/retire`, { method: 'POST', body: JSON.stringify(data) }));
}

export interface AnswerResponse {
  answer: string | null;
  limitation: { code: string; message: string } | null;
  citations: Array<{
    policyId: string;
    version: number;
    excerptId: string;
    text: string;
    sourceReference: string;
    effectiveFrom: string;
  }>;
}

export function usePolicyAnswer() {
  return usePolicyMutation<
    { question: string; appliesOn?: string; applicability?: PolicyApplicability },
    AnswerResponse
  >(async (data) => {
    try {
      return await request<AnswerResponse>('/api/policies/answer', { method: 'POST', body: JSON.stringify(data) });
    } catch (error) {
      // This route deliberately uses 422 for a policy limitation, while the
      // response body remains the normal answer/limitation/citations shape.
      const responseError = error as { status?: unknown; data?: unknown };
      if (responseError.status === 422 && responseError.data && typeof responseError.data === 'object') {
        return responseError.data as AnswerResponse;
      }
      throw error;
    }
  });
}

export interface PolicyExcerpt {
  isCurrent: boolean;
  policyId: string;
  version: number;
  excerptId: string;
  text: string;
  sourceReference: string;
  effectiveFrom: string;
}

export function usePolicyExcerpt(policyId: string | null, version: number | null, excerptId: string | null) {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: [...getPoliciesKey(scope), policyId, version, excerptId, 'excerpt'],
    queryFn: () => request<PolicyExcerpt>(`/api/policies/${policyId}/versions/${version}/excerpts/${excerptId}`),
    ...policyQueryOptions(scope),
    enabled: Boolean(policyId && version && excerptId && scope.organizationId && scope.userId),
  });
}

export function useHandoffs(enabled = true) {
  const scope = usePolicyScope();
  return useQuery({
    queryKey: getHandoffsKey(scope),
    queryFn: async () => (await request<{ handoffs: PolicyHandoff[] }>('/api/policies/handoffs')).handoffs,
    ...policyQueryOptions(scope),
    enabled: Boolean(enabled && scope.organizationId && scope.userId),
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useCreateHandoff() {
  return usePolicyMutation<
    { question: string; appliesOn?: string; applicability?: PolicyApplicability },
    { handoff: PolicyHandoff; deduplicated: boolean; externalDispatch: false }
  >((data) => request('/api/policies/handoffs', { method: 'POST', body: JSON.stringify(data) }));
}

export function useResolveHandoff() {
  return usePolicyMutation<{ handoffId: number; resolution: string }, { handoff: PolicyHandoff; externalDispatch: false }>(
    ({ handoffId, resolution }) => request(`/api/policies/handoffs/${handoffId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    }),
  );
}