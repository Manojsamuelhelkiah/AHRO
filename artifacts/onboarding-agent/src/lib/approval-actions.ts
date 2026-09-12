import {
  getGetOnboardingApprovalHistoryQueryKey,
  getGetOnboardingCaseQueryKey,
  getGetOnboardingCaseReadinessSlaQueryKey,
  getListOnboardingApprovalsQueryKey,
  getListOnboardingCaseEventsQueryKey,
} from '@workspace/api-client-react';

export const APPROVAL_PERMISSION_MESSAGE =
  'A current governance-approved specialist assignment is required for this decision';
export const APPROVAL_VERSION_MESSAGE =
  'This review has no valid version. Reload the review before taking action.';
export const APPROVAL_STALE_MESSAGE =
  'This review changed before your decision was recorded. The latest review has been reloaded; review it again before submitting.';

export type ApprovalActionTarget = {
  id: number;
  caseId?: number | null;
  version?: unknown;
  status?: string | null;
  hitlPattern?: string | null;
  ruleRef?: string | null;
  agent?: string | null;
};

export type ApprovalAuthorityState = {
  /** Result of the server's live, authenticated specialist preflight. */
  canDecide: boolean;
  /** Fail-closed reason supplied by the same authority checker as the write. */
  reason?: string | null;
  loading: boolean;
};

export type ApprovalDecisionPayload = {
  id: number;
  data: {
    decision: string;
    comment?: string;
    expectedVersion: number;
  };
};

export type ApprovalActionAvailability = {
  canAct: boolean;
  reason: string | null;
};

export function isValidApprovalVersion(
  approval: Pick<ApprovalActionTarget, 'version'> | null | undefined,
): approval is Pick<ApprovalActionTarget, 'version'> & { version: number } {
  return (
    approval != null &&
    typeof approval.version === 'number' &&
    Number.isInteger(approval.version) &&
    approval.version >= 1
  );
}

export function isApprovalAcknowledgement(
  approval: Pick<ApprovalActionTarget, 'hitlPattern' | 'ruleRef' | 'agent'>,
): boolean {
  const ruleRef = approval.ruleRef?.toLowerCase() ?? '';
  const agent = approval.agent?.toLowerCase() ?? '';
  return (
    approval.hitlPattern === 'hard-block' ||
    ruleRef.includes('sla') ||
    agent === 'readiness-watcher' ||
    agent === 'system-watcher'
  );
}

export function getApprovalActionLabel(
  approval: Pick<ApprovalActionTarget, 'hitlPattern' | 'ruleRef' | 'agent'>,
): 'Ack review' | 'Approve' {
  return isApprovalAcknowledgement(approval) ? 'Ack review' : 'Approve';
}

export function getApprovalSuccessMessage(
  approval: Pick<ApprovalActionTarget, 'hitlPattern' | 'ruleRef' | 'agent'>,
  decision: string,
): string {
  if (isApprovalAcknowledgement(approval)) {
    return 'Review acknowledged. This records the review only; it does not complete assets or advance the case.';
  }
  return decision === 'approved' ? 'Review approved.' : 'Review rejected.';
}

export function getApprovalVersionLabel(
  approval: Pick<ApprovalActionTarget, 'version'> | null | undefined,
): string {
  return isValidApprovalVersion(approval) ? `V${approval.version}` : 'Vunknown';
}

export function getApprovalActionAvailability(
  approval: ApprovalActionTarget | null | undefined,
  authority: ApprovalAuthorityState,
): ApprovalActionAvailability {
  if (authority.loading) {
    return {
      canAct: false,
      reason: 'Checking current specialist authority…',
    };
  }

  if (!approval || !isValidApprovalVersion(approval)) {
    return {
      canAct: false,
      reason: APPROVAL_VERSION_MESSAGE,
    };
  }

  if (approval.status !== 'pending') {
    return {
      canAct: false,
      reason: 'This review is no longer pending.',
    };
  }

  // Browser membership roles must never enable an approval action. This is a
  // read-only preflight of the same server-side current-state checker the
  // mutation runs under its tenant fence (governance, membership, scope,
  // assignment validity, case scope, revision, and SoD).
  if (!authority.canDecide) {
    return {
      canAct: false,
      reason: authority.reason || APPROVAL_PERMISSION_MESSAGE,
    };
  }
  return { canAct: true, reason: null };
}

export function buildApprovalDecisionPayload(
  approval: ApprovalActionTarget | null | undefined,
  authority: ApprovalAuthorityState,
  decision: string,
  comment?: string,
): ApprovalDecisionPayload | null {
  if (
    !approval ||
    !getApprovalActionAvailability(approval, authority).canAct ||
    !isValidApprovalVersion(approval)
  ) {
    return null;
  }

  return {
    id: approval.id,
    data: {
      decision,
      ...(comment ? { comment } : {}),
      expectedVersion: approval.version,
    },
  };
}

export function getApprovalMutationErrorMessage(error: unknown): string {
  const status = getErrorStatus(error);

  if (status === 403) {
    return `API 403: ${APPROVAL_PERMISSION_MESSAGE}.`;
  }

  if (status === 409) {
    return APPROVAL_STALE_MESSAGE;
  }

  if (status == null) {
    const detail = getErrorMessage(error);
    return detail
      ? `Network error while submitting this review: ${detail}`
      : 'Network error while submitting this review. Check your connection and try again.';
  }

  const detail = getErrorMessage(error);
  return detail
    ? `Unable to submit this review (API ${status}): ${detail}`
    : `Unable to submit this review (API ${status}).`;
}

export function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function getErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string' || message.trim() === '') return null;

  // The generated client prefixes API errors with HTTP status. The status is
  // already rendered above, so do not repeat that prefix in the notice.
  return message.replace(/^HTTP \d+(?: [^:]+)?:\s*/i, '').trim() || null;
}

export function getApprovalRefreshQueryKeys(
  target: Pick<ApprovalActionTarget, 'id' | 'caseId'>,
): readonly (readonly unknown[])[] {
  const keys: Array<readonly unknown[]> = [
    // This is intentionally the key prefix, not one status variant. It
    // refreshes pending, all, and any future approval-list filters together.
    getListOnboardingApprovalsQueryKey(),
  ];

  if (typeof target.caseId === 'number' && Number.isInteger(target.caseId)) {
    keys.push(
      getGetOnboardingCaseQueryKey(target.caseId),
      getListOnboardingCaseEventsQueryKey(target.caseId),
    );
  }

  if (typeof target.id === 'number' && Number.isInteger(target.id)) {
    keys.push(getGetOnboardingApprovalHistoryQueryKey(target.id));
  }

  if (typeof target.caseId === 'number' && Number.isInteger(target.caseId)) {
    keys.push(getGetOnboardingCaseReadinessSlaQueryKey(target.caseId));
  }

  return keys;
}

export async function refreshApprovalViews(
  queryClient: {
    invalidateQueries: (filters: { queryKey: readonly unknown[] }) => Promise<unknown>;
  },
  target: Pick<ApprovalActionTarget, 'id' | 'caseId'>,
): Promise<void> {
  await Promise.all(
    getApprovalRefreshQueryKeys(target).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

/** Poll only while an approval queue contains unresolved reviews. */
export function getApprovalRefetchInterval(data: unknown): number | false {
  return Array.isArray(data) &&
    data.some(
      (approval) =>
        approval &&
        typeof approval === 'object' &&
        (approval as { status?: unknown }).status === 'pending',
    )
    ? 5000
    : false;
}