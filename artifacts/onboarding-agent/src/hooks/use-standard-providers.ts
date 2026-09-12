import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getPinnedOrganizationIdForPage } from "@workspace/api-client-react";
import type { 
  StandardProviderKey, 
  StandardProviderConfigurationState,
  StandardProviderSourceRecordType,
  NormalizedProviderSourceState
} from "../lib/standard-provider-contracts";

export type StandardProviderStatus = {
  key: StandardProviderKey;
  label: string;
  sourceOfTruth: string;
  documentedApi: string | null;
  documentationUrl: string | null;
  defaultMappings: Record<string, string>;
  fieldMappings: Record<string, string>;
  configurationState: StandardProviderConfigurationState;
  sourceObservationState: string;
  fulfillmentState: string;
  manualOwner: string;
  sourceRecords: Array<{
    caseId: number | null;
    recordType: StandardProviderSourceRecordType;
    sourceRecordId: string;
    normalizedState: NormalizedProviderSourceState;
    sourceObservedAt: string;
    evidenceReference: string | null;
    evidenceClass: string;
  }>;
  remoteDispatchEnabled: boolean;
  liveReadinessEligible: boolean;
  launchBlockers: string[];
  setupBlockers: string[];
  manualFulfillment: {
    status: string;
    evidence: string;
    consent: string;
    cutoff: string;
    reconciliation: string;
    failure: string;
  } | undefined;
  version: number;
  updatedAt: string | null;
};

export type ProvidersStatusResponse = {
  providers: StandardProviderStatus[];
  decisions: unknown[];
};

function getPinnedOrgId(): string {
  const orgId = getPinnedOrganizationIdForPage();
  if (!orgId) throw new Error("No organization selected. Please select an organization.");
  return orgId;
}

function getHeaders(orgId: string) {
  return {
    "Content-Type": "application/json",
    "x-organization-id": orgId,
  };
}

export function useStandardProvidersStatus() {
  const orgId = getPinnedOrganizationIdForPage();
  return useQuery({
    queryKey: ["onboarding-standard-providers", "status", orgId],
    queryFn: async (): Promise<ProvidersStatusResponse> => {
      if (!orgId) throw new Error("No organization selected. Please select an organization.");
      const response = await fetch("/api/onboarding/standard-providers/status", {
        headers: getHeaders(orgId),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          err.message || 
          (response.status === 403 
            ? "Organization owner or admin role required to access standard providers." 
            : "Failed to fetch standard providers status")
        );
      }
      return response.json();
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });
}

export function useUpdateStandardProviderConfiguration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ providerKey, data }: { 
      providerKey: StandardProviderKey; 
      data: {
        configurationState: string;
        fieldMappings: Record<string, string>;
        expectedVersion: number;
        sandboxEvidenceReference?: string;
        operatorApprovalReference?: string;
      }
    }) => {
      const orgId = getPinnedOrgId();
      const response = await fetch(`/api/onboarding/standard-providers/${providerKey}/configuration`, {
        method: "PUT",
        headers: getHeaders(orgId),
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || "Failed to update standard provider configuration");
      }
      return response.json();
    },
    onSuccess: () => {
      const orgId = getPinnedOrganizationIdForPage();
      queryClient.invalidateQueries({ queryKey: ["onboarding-standard-providers", "status", orgId] });
    },
  });
}

export function useRefreshStandardProviderSourceConfirmation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ providerKey, data }: { 
      providerKey: StandardProviderKey; 
      data: {
        caseId: number;
        workersUniqId?: string;
        periodOfServiceId?: string;
        requestSysId?: string;
      }
    }) => {
      const orgId = getPinnedOrgId();
      const response = await fetch(`/api/onboarding/standard-providers/${providerKey}/source-confirmations/refresh`, {
        method: "POST",
        headers: getHeaders(orgId),
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || "Failed to refresh source confirmation");
      }
      return response.json();
    },
    onSuccess: () => {
      const orgId = getPinnedOrganizationIdForPage();
      queryClient.invalidateQueries({ queryKey: ["onboarding-standard-providers", "status", orgId] });
    },
  });
}
