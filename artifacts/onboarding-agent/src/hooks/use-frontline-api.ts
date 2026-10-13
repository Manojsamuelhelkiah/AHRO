import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useUser } from '@clerk/react';

export type FrontlineReadiness = {
  version: number;
  applicable: boolean;
  access: {
    readOnly: boolean;
    historyRead: boolean;
    kpiRead: boolean;
    fulfillmentEdit: boolean;
    exceptionEdit: boolean;
    releaseEdit: boolean;
    evidenceEdit: Record<string, boolean>;
  };
  release: {
    eligible: boolean;
    recorded: boolean;
    blockers: string[];
    reblocked: boolean;
  };
  fulfillments: Array<{
    item: string;
    sizeRecorded: boolean;
    requestedQuantity: number;
    issuedQuantity: number;
    issuerTimestamp: string;
    acknowledged: boolean;
    status: 'issued' | 'shortage' | 'substituted' | 'deferred';
  }>;
  evidenceStatuses?: Array<{
    kind: string;
    statutoryKey?: string;
    skillRequirementKey?: string;
    status: 'verified' | 'rejected' | 'revoked';
    expiryState: 'expired' | 'current-with-expiry' | 'no-expiry-recorded';
  }>;
};

export type FrontlineEvidenceHistory = {
  evidence: Array<{
    id: number;
    kind: string;
    statutoryKey?: string;
    skillRequirementKey?: string;
    status: 'verified' | 'rejected' | 'revoked';
    expiryState: 'expired' | 'current-with-expiry' | 'no-expiry-recorded';
  }>;
  exceptions: Array<{
    id: number;
    item: string;
    type: 'substitution' | 'deferment';
    status: 'current' | 'expired' | 'revoked';
  }>;
};

export type FrontlineAcknowledgementMethod = 'in-person' | 'signed-receipt' | 'verified-digital';

export type FrontlineKpis = {
  caseId: number;
  metrics: {
    floorReadyCycleSeconds: number | null;
    medicalTurnaroundSeconds: number | null;
    safetyInductionCompleted: boolean;
    ppeIssuanceCompliant: boolean;
    statutoryRegistrationRecorded: boolean;
    attrition0To30Days: { state: "pending-review" } | { state: "observed"; exitedWithin30Days: boolean; actualJoinedAt: string; actualExitAt?: string };
  };
  pendingReviewTargets: string[];
  inputs: Array<{ kind: string; count: number; firstObservedAt: string; lastObservedAt: string }>;
};

export function useGetFrontlineReadiness(caseId: number, options?: { enabled?: boolean }) {
  const { user } = useUser();
  return useQuery({
    queryKey: ['frontline-readiness', caseId, getPinnedOrganizationIdForPage(), user?.id],
    queryFn: () => customFetch<FrontlineReadiness>(`/api/onboarding/cases/${caseId}/frontline/readiness`, { method: 'GET', responseType: 'json' }),
    enabled: !!caseId && options?.enabled !== false,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useGetFrontlineEvidenceHistory(caseId: number, options?: { enabled?: boolean }) {
  const { user } = useUser();
  return useQuery({
    queryKey: ['frontline-evidence-history', caseId, getPinnedOrganizationIdForPage(), user?.id],
    queryFn: () => customFetch<FrontlineEvidenceHistory>(`/api/onboarding/cases/${caseId}/frontline/evidence-history`, { method: 'GET', responseType: 'json' }),
    enabled: !!caseId && options?.enabled !== false,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useGetFrontlineKpis(caseId: number, options?: { enabled?: boolean }) {
  const { user } = useUser();
  return useQuery({
    queryKey: ['frontline-kpis', caseId, getPinnedOrganizationIdForPage(), user?.id],
    queryFn: async () => {
      try {
        return await customFetch<FrontlineKpis>(`/api/onboarding/cases/${caseId}/frontline/kpis`, { method: 'GET', responseType: 'json' });
      } catch (err: any) {
        if (err?.response?.status === 403 || err?.status === 403) return null;
        throw err;
      }
    },
    enabled: !!caseId && options?.enabled !== false,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function usePostFrontlineEvidence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number, data: { expectedVersion: number, kind: string, evidenceReference: string, issuerTimestamp: string, effectiveAt?: string, expiresAt?: string, statutoryKey?: string, skillRequirementKey?: string, subjectAgeYears?: number, status: 'verified' | 'rejected' | 'revoked', revocationReference?: string } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-evidence-history', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-kpis', variables.caseId] });
    }
  });
}

export function usePostFrontlineFulfillment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number, data: { expectedVersion: number, item: string, assetReference: string, size?: string, requestedQuantity: number, issuedQuantity: number, issuerTimestamp: string, acknowledgedAt?: string, acknowledgementRecipientReference?: string, acknowledgementMethod?: FrontlineAcknowledgementMethod, status: 'issued' | 'shortage' | 'substituted' | 'deferred', exceptionId?: number } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/fulfillments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-kpis', variables.caseId] });
    }
  });
}

export function usePostFrontlineFloorRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number, data: { expectedVersion: number } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/floor-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-kpis', variables.caseId] });
    }
  });
}

export function usePostFrontlineKpiInput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number, data: { expectedVersion: number, kind: string, occurredAt: string, actualExitAt?: string, evidenceReference: string } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/kpi-inputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-kpis', variables.caseId] });
    }
  });
}

export function usePostFrontlinePolicyException() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number, data: { expectedVersion: number, item: string, type: 'substitution' | 'deferment', reviewReference: string, effectiveAt: string, expiresAt?: string } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/policy-exceptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-evidence-history', variables.caseId] });
    }
  });
}

export function useRevokeFrontlineEvidence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, evidenceId, data }: { caseId: number, evidenceId: number, data: { expectedVersion: number, revocationReference: string } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/evidence/${evidenceId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-evidence-history', variables.caseId] });
    }
  });
}

export function useRevokeFrontlinePolicyException() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, exceptionId, data }: { caseId: number, exceptionId: number, data: { expectedVersion: number, revocationReference: string } }) =>
      customFetch(`/api/onboarding/cases/${caseId}/frontline/policy-exceptions/${exceptionId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        responseType: 'json',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['frontline-readiness', variables.caseId] });
      queryClient.invalidateQueries({ queryKey: ['frontline-evidence-history', variables.caseId] });
    }
  });
}
