import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  getGetOnboardingDemoControllerQueryKey,
} from "@workspace/api-client-react";

export type DecisionStatus = "draft" | "provisional" | "approved" | "rejected" | "superseded";

export interface GovernanceDecision {
  key: string;
  title: string;
  revision: number;
  approvedRevision: number | null;
  status: DecisionStatus;
  proposedValue: unknown;
  rationale: string;
  risk: string;
  accountableRole: string;
  reviewDueAt?: string | null;
  impactedWorkflows?: string[];
  sourceReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceRequirement {
  key: string;
  title: string;
  sourceReference: string;
  reviewOwnerRole: string;
  version: number;
  coverageState: "gap" | "partial" | "covered";
  coverage: {
    implemented: boolean;
    tested: boolean;
    configured: boolean;
    approvedForLive: boolean;
  };
  relatedImplementation?: string;
  evidenceReference?: string;
  updatedAt: string;
}

export interface GovernanceAssignment {
  id: number;
  role: string;
  assigneeUserId: string;
  verificationStatus: "pending" | "verified";
  verifiedByUserId: string;
  verificationReference: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedByUserId?: string | null;
  createdAt: string;
}

export interface GovernanceDecisionReview {
  id: number;
  revision: number;
  outcome: "approved" | "rejected";
  reason: string;
  authorityAssignmentId: number;
  reviewedByUserId: string;
  verificationReference: string;
  createdAt: string;
}

export interface GovernanceHistoryEvent {
  id: number;
  entityType: string;
  entityKey: string;
  eventType: string;
  detail: Record<string, unknown>;
  createdAt: string;
  actorUserId: string | null;
}

const get = async <T>(url: string): Promise<T> => customFetch<T>(url, { method: "GET" });
const post = async <T>(url: string, body?: any): Promise<T> => customFetch<T>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const put = async <T>(url: string, body?: any): Promise<T> => customFetch<T>(url, { method: "PUT", body: body ? JSON.stringify(body) : undefined });

export const keys = {
  all: ["governance"] as const,
  decisions: () => [...keys.all, "decisions"] as const,
  decisionHistory: (key: string) => [...keys.decisions(), key, "history"] as const,
  requirements: () => [...keys.all, "requirements"] as const,
  assignments: () => [...keys.all, "assignments"] as const,
  history: () => [...keys.all, "history"] as const,
};

function invalidateGovernanceAndDemoReadiness(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: keys.all });
  qc.invalidateQueries({ queryKey: getGetOnboardingDemoControllerQueryKey() });
}

export function useGetGovernanceDecisions(options?: { query?: { refetchInterval?: number; refetchIntervalInBackground?: boolean } }) {
  return useQuery({ 
    queryKey: keys.decisions(), 
    queryFn: () => get<{ decisions: GovernanceDecision[] }>("/api/governance/decisions").then(r => r.decisions),
    ...options?.query
  });
}

export function usePostGovernanceDecisions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<GovernanceDecision>) => post<{ decision: GovernanceDecision }>("/api/governance/decisions", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useGetGovernanceDecisionsKeyHistory(key: string) {
  return useQuery({
    queryKey: keys.decisionHistory(key),
    queryFn: () => get<{ revisions: GovernanceDecision[], reviews: GovernanceDecisionReview[] }>(`/api/governance/decisions/${key}/history`),
    enabled: !!key,
    refetchInterval: 30000,
  });
}

export function usePostGovernanceDecisionsKeyRevisions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; expectedRevision: number; data: Partial<GovernanceDecision> }) =>
      post<{ decision: GovernanceDecision }>(`/api/governance/decisions/${vars.key}/revisions`, { expectedRevision: vars.expectedRevision, ...vars.data }),
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
    onError: () => qc.invalidateQueries({ queryKey: keys.decisions() }),
  });
}

export function usePostGovernanceDecisionsKeyReviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; expectedRevision: number; outcome: "approved" | "rejected"; reason: string; verificationReference: string }) =>
      post<{ decision: GovernanceDecision }>(`/api/governance/decisions/${vars.key}/reviews`, {
        revision: vars.expectedRevision, outcome: vars.outcome,
        reason: vars.reason, verificationReference: vars.verificationReference,
      }),
    onSuccess: (data, vars) => {
      invalidateGovernanceAndDemoReadiness(qc);
    },
    onError: (_error, vars) => {
      qc.invalidateQueries({ queryKey: keys.decisions() });
      qc.invalidateQueries({ queryKey: keys.decisionHistory(vars.key) });
      qc.invalidateQueries({ queryKey: keys.assignments() });
    },
  });
}

export function useGetGovernanceRequirements(options?: { query?: { refetchInterval?: number; refetchIntervalInBackground?: boolean } }) {
  return useQuery({ 
    queryKey: keys.requirements(), 
    queryFn: () => get<{ requirements: GovernanceRequirement[] }>("/api/governance/requirements").then(r => r.requirements),
    ...options?.query
  });
}

export function usePutGovernanceRequirementsKeyCoverage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; expectedVersion: number; coverage: GovernanceRequirement["coverage"]; relatedImplementation?: string; evidenceReference?: string }) =>
      put<{ requirement: GovernanceRequirement }>(`/api/governance/requirements/${vars.key}/coverage`, {
        expectedVersion: vars.expectedVersion, ...vars.coverage,
        relatedImplementation: vars.relatedImplementation, evidenceReference: vars.evidenceReference,
      }),
    onSuccess: () => invalidateGovernanceAndDemoReadiness(qc),
    onError: () => qc.invalidateQueries({ queryKey: keys.requirements() }),
  });
}

export function useGetGovernanceAssignments(options?: { query?: { refetchInterval?: number; refetchIntervalInBackground?: boolean } }) {
  return useQuery({ 
    queryKey: keys.assignments(), 
    queryFn: () => get<{ assignments: GovernanceAssignment[] }>("/api/governance/assignments").then(r => r.assignments),
    ...options?.query
  });
}

export function usePostGovernanceAssignments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<GovernanceAssignment>) => post<{ assignment: GovernanceAssignment }>("/api/governance/assignments", data),
    onSuccess: () => invalidateGovernanceAndDemoReadiness(qc),
  });
}

export function usePostGovernanceAssignmentsIdRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => post<{ assignment: GovernanceAssignment }>(`/api/governance/assignments/${id}/revoke`),
    onSuccess: () => invalidateGovernanceAndDemoReadiness(qc),
  });
}

export function useGetGovernanceHistory() {
  return useQuery({ queryKey: keys.history(), queryFn: () => get<{ history: GovernanceHistoryEvent[] }>("/api/governance/history").then(r => r.history), refetchInterval: 30000 });
}

export function usePostGovernanceRemindersDispatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => post<{ dispatched: number }>("/api/governance/reminders/dispatch"), onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }) });
}

export function usePostGovernanceAuthorityBootstrap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { role: string; assigneeUserId: string; verificationReference: string }) => post<{ assignment: GovernanceAssignment }>("/api/governance/authority-bootstrap", data),
    onSuccess: () => invalidateGovernanceAndDemoReadiness(qc),
  });
}

export function usePostGovernanceAssignmentsIdVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; verificationReference: string }) => post<{ assignment: GovernanceAssignment }>(`/api/governance/assignments/${vars.id}/verify`, { verificationReference: vars.verificationReference }),
    onSuccess: () => invalidateGovernanceAndDemoReadiness(qc),
  });
}
