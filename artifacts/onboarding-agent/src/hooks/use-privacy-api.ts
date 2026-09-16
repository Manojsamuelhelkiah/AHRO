import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import { customFetch, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';

const API_BASE = '/api/privacy';

export type RetentionPolicy = {
  id?: number;
  dataClass: string;
  purpose: string;
  jurisdiction: string;
  lawfulBasis: string;
  providerSharingApproved: boolean;
  permittedProviders?: string[];
  retentionDays: number;
  policyReference: string;
  approvalReference: string;
  expectedRevision?: number;
  revision?: number;
};

export type PrivacySettings = {
  policies: RetentionPolicy[];
};

export type StarterPolicyProposal = {
  dataClass: string;
  jurisdiction: string;
  purpose: string;
  lawfulBasis: string;
  retentionDays: number;
  providerSharingApproved: false;
  permittedProviders: [];
  policyReference: string;
  approvalReference: string;
};

export type StarterPolicy = {
  inactive: true;
  reviewRequired: true;
  country: string;
  version: number;
  proposals: StarterPolicyProposal[];
};

export type CurrentOrganizationMembership = {
  organizationId: string;
  name: string;
  slug: string;
  primaryCountry: string;
  role: 'owner' | 'admin' | 'member';
};

export type RetentionShorteningPreview = {
  confirmationId: number;
  expiresAt: string;
  affectedObjectCount: number;
  heldRecordCount: number;
  requiresExplicitAuthorizedConfirmation: boolean;
  confirmationPhrase: string;
};

export type LifecycleHold = {
  id: number;
  dataClass: string | null;
  caseId: number | null;
  objectPath: string | null;
  reason: string;
  reference: string;
  active: boolean;
  createdAt: string;
};

export type DeletionJob = {
  id: number;
  organizationId: string;
  policyId: number;
  policyRevision: number;
  dataClass: string;
  uploadId: number | null;
  recordKind: string;
  recordId: string;
  status: 'queued' | 'processing' | 'blocked' | 'failed' | 'completed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

// HOOKS

export function useGetLifecyclePolicies() {
  const { userId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage();
  return useQuery<{ policies: RetentionPolicy[] }>({
    queryKey: ['lifecyclePolicies', orgId, userId],
    queryFn: () => customFetch(`${API_BASE}/lifecycle/policies`),
    enabled: !!orgId && !!userId,
  });
}

export function useUpdateLifecyclePolicy() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (policy: RetentionPolicy) =>
      customFetch(`${API_BASE}/lifecycle/policies`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecyclePolicies', orgId] });
    },
  });
}

export function useGetStarterLifecyclePolicy(country?: string) {
  const { userId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage();
  const query = country?.trim() ? `?country=${encodeURIComponent(country.trim())}` : '';
  return useQuery<{ starterPolicy: StarterPolicy }>({
    queryKey: ['starterLifecyclePolicy', orgId, userId, country?.trim() || ''],
    queryFn: () => customFetch(`${API_BASE}/lifecycle/starter-policy${query}`),
    enabled: !!orgId && !!userId,
  });
}

export function useGetCurrentOrganization() {
  const { userId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage();
  return useQuery<{ activeOrganizationId: string | null; memberships: CurrentOrganizationMembership[] }>({
    queryKey: ['currentOrganization', orgId, userId],
    queryFn: () => customFetch('/api/organizations/current'),
    enabled: !!orgId && !!userId,
  });
}

export function useUpdateOrganizationPrimaryCountry() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (primaryCountry: string) => customFetch('/api/organizations/current/primary-country', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryCountry }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['currentOrganization', orgId] });
      qc.invalidateQueries({ queryKey: ['starterLifecyclePolicy', orgId] });
    },
  });
}

export function useUpdateStarterLifecyclePolicy() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (policy: {
      country: string;
      expectedVersion: number;
      proposals: StarterPolicyProposal[];
    }) =>
      customFetch(`${API_BASE}/lifecycle/starter-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['starterLifecyclePolicy', orgId] });
    },
  });
}

export function usePreviewRetentionShortening() {
  return useMutation({
    mutationFn: (policy: RetentionPolicy) =>
      customFetch(`${API_BASE}/lifecycle/policies/shortening-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      }).then(res => res as RetentionShorteningPreview),
  });
}

export function useConfirmRetentionShortening() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (params: { confirmationId: number, confirmationPhrase: string, policy: RetentionPolicy }) =>
      customFetch(`${API_BASE}/lifecycle/shortening-previews/${params.confirmationId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationPhrase: params.confirmationPhrase, ...params.policy }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecyclePolicies', orgId] });
    },
  });
}

export function useListLifecycleHolds() {
  const { userId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage();
  return useQuery<{ holds: LifecycleHold[] }>({
    queryKey: ['lifecycleHolds', orgId, userId],
    queryFn: () => customFetch(`${API_BASE}/lifecycle/holds`),
    enabled: !!orgId && !!userId,
  });
}

export function useListLifecycleDeletionJobs() {
  const { userId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage();
  return useQuery<{ jobs: DeletionJob[] }>({
    queryKey: ['lifecycleDeletionJobs', orgId, userId],
    queryFn: () => customFetch(`${API_BASE}/lifecycle/deletion-jobs`),
    enabled: !!orgId && !!userId,
    refetchInterval: 30_000,
  });
}

export function useRetryDeletionJob() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (jobId: string | number) =>
      customFetch(`${API_BASE}/lifecycle/deletion-jobs/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecycleDeletionJobs', orgId] });
    },
  });
}

export function useSetLifecycleHold() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (params: { caseId: number, reason: string, reference: string, dataClass?: string, objectPath?: string }) =>
      customFetch(`${API_BASE}/lifecycle/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecycleHolds', orgId] });
    },
  });
}

export function useReleaseLifecycleHold() {
  const qc = useQueryClient();
  const orgId = getPinnedOrganizationIdForPage();
  return useMutation({
    mutationFn: (params: { holdId: number, reference: string }) =>
      customFetch(`${API_BASE}/lifecycle/holds/${params.holdId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: params.reference }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecycleHolds', orgId] });
    },
  });
}