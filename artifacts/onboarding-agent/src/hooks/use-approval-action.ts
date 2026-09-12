import { useCallback, useEffect, useRef, useState } from 'react';
import { useDecideOnboardingApproval } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { toast } from './use-toast';
import {
  APPROVAL_PERMISSION_MESSAGE,
  APPROVAL_STALE_MESSAGE,
  APPROVAL_VERSION_MESSAGE,
  type ApprovalActionTarget,
  type ApprovalAuthorityState,
  buildApprovalDecisionPayload,
  getApprovalActionAvailability,
  getApprovalActionLabel,
  getApprovalMutationErrorMessage,
  getApprovalSuccessMessage,
  getErrorStatus,
  isValidApprovalVersion,
  refreshApprovalViews,
} from '@/lib/approval-actions';

export type ApprovalActionDecision = 'approved' | 'rejected';

type ApprovalCapabilityResponse = {
  canDecide: boolean;
  reason: string | null;
  version: number;
};

function currentPinnedOrganizationId(): string | null {
  try {
    return getPinnedOrganizationIdForPage() || localStorage.getItem('activeOrganizationId');
  } catch {
    return null;
  }
}

/** Read-only capability preflight; the decision mutation always rechecks it. */
export function useApprovalCapability(
  approval: ApprovalActionTarget | null | undefined,
) {
  const validTarget = approval && isValidApprovalVersion(approval) && approval.status === 'pending';
  const organizationId = currentPinnedOrganizationId();
  return useQuery({
    queryKey: ['/api/onboarding/approvals', approval?.id ?? null, 'capability', approval?.version ?? null, organizationId],
    enabled: Boolean(validTarget),
    retry: false,
    refetchInterval: validTarget ? 5000 : false,
    queryFn: async (): Promise<ApprovalCapabilityResponse> => {
      const response = await fetch(`/api/onboarding/approvals/${approval!.id}/capability`, {
        credentials: 'include',
        headers: organizationId ? { 'x-organization-id': organizationId } : undefined,
      });
      if (!response.ok) throw new Error(`Capability preflight failed (API ${response.status})`);
      return response.json() as Promise<ApprovalCapabilityResponse>;
    },
  });
}

export function useApprovalAction(
  approval: ApprovalActionTarget | null | undefined,
  options?: { caseId?: number },
) {
  const queryClient = useQueryClient();
  // Conflicts and transport errors must never silently resubmit a human
  // decision. A refreshed review is the only path to another user action.
  const decide = useDecideOnboardingApproval({ mutation: { retry: false } });
  const {
    mutate,
    reset,
    isPending: isDecisionPending,
  } = decide;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const caseId =
    options?.caseId ??
    (approval && typeof approval.caseId === 'number' ? approval.caseId : undefined);
  const target = approval
    ? { ...approval, caseId }
    : null;
  const capability = useApprovalCapability(target);
  const capabilityMatchesVersion = capability.data?.version === target?.version;
  const authority: ApprovalAuthorityState = {
    // A preflight response for an older cycle must not enable a newer one.
    canDecide: capability.data?.canDecide === true && capabilityMatchesVersion,
    reason: capabilityMatchesVersion
      ? capability.data?.reason ?? null
      : 'approval_version_changed',
    loading: Boolean(target && target.status === 'pending' && capability.isLoading),
  };
  const approvalIdentity = approval
    ? `${approval.id}:${String(approval.version)}`
    : 'none';
  const actionContextIdentity = `${approvalIdentity}:${authority.canDecide}:${authority.reason ?? 'unknown'}:${authority.loading}`;
  const actionContextRef = useRef(actionContextIdentity);
  actionContextRef.current = actionContextIdentity;

  const availability = getApprovalActionAvailability(target, authority);
  const hasValidVersion = target != null && isValidApprovalVersion(target);
  const isPending = target?.status === 'pending';

  // A result from a previous review/version must never remain visible on a
  // newly-rendered review. Role changes also invalidate pending UI state.
  useEffect(() => {
    setActionError(null);
    setNotice(null);
    reset();
  }, [actionContextIdentity, reset]);

  const submit = useCallback(
    (decision: ApprovalActionDecision, comment?: string) => {
      if (!target) {
        setActionError(APPROVAL_VERSION_MESSAGE);
        return;
      }

      if (isDecisionPending) return;

      if (!availability.canAct) {
        setActionError(availability.reason ?? APPROVAL_PERMISSION_MESSAGE);
        return;
      }

      if (!isValidApprovalVersion(target)) {
        setActionError(APPROVAL_VERSION_MESSAGE);
        return;
      }

      const submittedContextIdentity = actionContextIdentity;
      setActionError(null);
      setNotice(null);

      const payload = buildApprovalDecisionPayload(
        target,
        authority,
        decision,
        comment,
      );
      if (!payload) {
        setActionError(
          availability.reason ??
            (hasValidVersion
              ? APPROVAL_PERMISSION_MESSAGE
              : APPROVAL_VERSION_MESSAGE),
        );
        return;
      }

      mutate(payload, {
        onSuccess: async () => {
          if (actionContextRef.current !== submittedContextIdentity) return;

          // A successful decision changes the queue, case orchestration,
          // event history, and readiness/SLA state. Show the success notice
          // even if a background refetch is slow.
          const successMessage = getApprovalSuccessMessage(target, decision);
          toast({ title: 'Review recorded', description: successMessage });
          setNotice(successMessage);
          try {
            await refreshApprovalViews(queryClient, {
              id: target.id,
              caseId,
            });
          } catch {
            // The decision succeeded; the next finite poll or reload will
            // reconcile a transient refresh failure.
          }
        },
        onError: async (error: unknown) => {
          if (actionContextRef.current !== submittedContextIdentity) return;

          // A conflict means another actor (including an email decision)
          // owns the version now. Refresh, but never resubmit the decision.
          if (getErrorStatus(error) === 409) {
            toast({
              title: 'Review changed',
              description: APPROVAL_STALE_MESSAGE,
            });
            try {
              await refreshApprovalViews(queryClient, {
                id: target.id,
                caseId,
              });
            } catch {
              // Keep the conflict notice explicit even if one dependent
              // query could not be refreshed.
            } finally {
              if (actionContextRef.current === submittedContextIdentity) {
                setActionError(APPROVAL_STALE_MESSAGE);
              }
            }
            return;
          }

          const errorMessage = getApprovalMutationErrorMessage(error);
          toast({ title: 'Review not submitted', description: errorMessage });
          setActionError(errorMessage);
        },
      });
    },
    [
      actionContextIdentity,
      availability.canAct,
      availability.reason,
      caseId,
      hasValidVersion,
      isDecisionPending,
      mutate,
      queryClient,
      authority,
      target,
    ],
  );

  const actionLabel = target
    ? getApprovalActionLabel(target)
    : 'Approve';

  return {
    isAuthorized: authority.canDecide,
    isAuthorityLoading: authority.loading,
    hasValidVersion,
    isPending,
    isPendingMutation: isDecisionPending,
    canAct: availability.canAct && !isDecisionPending,
    blockedMessage: availability.reason,
    actionLabel,
    actionError,
    notice,
    submit,
    clearMessages: () => {
      setActionError(null);
      setNotice(null);
    },
  };
}