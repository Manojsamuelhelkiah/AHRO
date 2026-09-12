import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  getGetOnboardingCaseQueryKey,
  getGetOnboardingCaseReadinessSlaQueryKey,
  getListOnboardingCaseEventsQueryKey,
  getListOnboardingCasesQueryKey,
} from "@workspace/api-client-react";

export interface GovernanceCaseDecisionSnapshot {
  key: string;
  revision: number;
  status: "draft" | "provisional" | "approved" | "rejected" | "superseded";
  domain: "legal" | "privacy" | "safety";
  impactedWorkflows: string[];
}

export interface GovernanceCaseSnapshot {
  schemaVersion: "governance-case-snapshot/v1";
  version: number;
  adoptedAt: string;
  decisions: GovernanceCaseDecisionSnapshot[];
}

export interface GovernanceCaseImpact {
  key: string;
  adoptedRevision: number | null;
  currentRevision: number | null;
  impactedWorkflows: string[];
  reason: "new-decision" | "revision-available" | "approval-revoked-or-missing";
  blocksLiveActions: boolean;
}

/** The case route returns this envelope; it does not return a synthetic policy version. */
export interface GovernanceCaseImpactResponse {
  snapshot: GovernanceCaseSnapshot | null;
  impacts: GovernanceCaseImpact[];
}

const get = async <T>(url: string): Promise<T> => customFetch<T>(url, { method: "GET" });
const post = async <T>(url: string, body?: unknown): Promise<T> =>
  customFetch<T>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const keys = {
  impact: (caseId: number) => [`/api/onboarding/cases/${caseId}/governance-impact`] as const,
};

export function governanceCaseImpactQuery(caseId: number) {
  return {
    queryKey: keys.impact(caseId),
    queryFn: () => get<GovernanceCaseImpactResponse>(`/api/onboarding/cases/${caseId}/governance-impact`),
    enabled: Number.isInteger(caseId) && caseId > 0,
  };
}

export function governanceRebaseInvalidationKeys(caseId: number) {
  return [
    keys.impact(caseId),
    getGetOnboardingCaseQueryKey(caseId),
    getGetOnboardingCaseReadinessSlaQueryKey(caseId),
    getListOnboardingCaseEventsQueryKey(caseId),
    getListOnboardingCasesQueryKey(),
  ] as const;
}

export function useGetGovernanceCaseImpact(caseId: number) {
  return useQuery(governanceCaseImpactQuery(caseId));
}

export function usePostGovernanceCaseRebase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { caseId: number; expectedSnapshotVersion: number; reason: string }) =>
      post<{ snapshot: GovernanceCaseSnapshot; freshFinalApprovalRequired: true }>(
        `/api/onboarding/cases/${vars.caseId}/governance-rebase`,
        {
          expectedSnapshotVersion: vars.expectedSnapshotVersion,
          reason: vars.reason,
        },
      ),
    onSuccess: (data, vars) => {
      // Rebase writes the case row, reopens Gate C, and appends a case event.
      // These are the generated query keys, rather than look-alike local keys.
      for (const queryKey of governanceRebaseInvalidationKeys(vars.caseId)) {
        qc.invalidateQueries({ queryKey });
      }
    },
    onError: (_error, vars) => {
      // A 409 is a compare-and-swap response. Refresh the actual snapshot
      // token so the operator can review it before deliberately retrying.
      qc.invalidateQueries({ queryKey: keys.impact(vars.caseId) });
      qc.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(vars.caseId) });
      qc.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(vars.caseId) });
    },
  });
}