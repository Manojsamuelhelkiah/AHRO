import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_PERMISSION_MESSAGE,
  APPROVAL_STALE_MESSAGE,
  APPROVAL_VERSION_MESSAGE,
  buildApprovalDecisionPayload,
  getApprovalActionAvailability,
  getApprovalMutationErrorMessage,
  getApprovalRefreshQueryKeys,
  getApprovalRefetchInterval,
  refreshApprovalViews,
} from './approval-actions';

const pendingApproval = {
  id: 7,
  caseId: 42,
  version: 3,
  status: 'pending',
  hitlPattern: 'approve-before-act',
  ruleRef: null,
  agent: 'hr-reviewer',
};

test('a failed current-authority preflight disables approval actions', () => {
  const member = getApprovalActionAvailability(pendingApproval, {
    canDecide: false,
    loading: false,
  });
  assert.equal(member.canAct, false);
  assert.equal(member.reason, APPROVAL_PERMISSION_MESSAGE);

  const scopedOut = getApprovalActionAvailability(pendingApproval, {
    canDecide: false,
    reason: 'separation_of_duties_requester_conflict',
    loading: false,
  });
  assert.equal(scopedOut.canAct, false);
  assert.equal(scopedOut.reason, 'separation_of_duties_requester_conflict');

  const unknownRole = getApprovalActionAvailability(pendingApproval, {
    canDecide: false,
    loading: true,
  });
  assert.equal(unknownRole.canAct, false);
  assert.match(unknownRole.reason ?? '', /Checking current specialist authority/);
});

test('only a current scoped capability enables a valid pending review', () => {
  const owner = getApprovalActionAvailability(pendingApproval, {
    canDecide: true,
    loading: false,
  });
  assert.equal(owner.canAct, true);
  assert.equal(owner.reason, null);
  assert.deepEqual(
    buildApprovalDecisionPayload(pendingApproval, { canDecide: true, loading: false }, 'approved'),
    {
      id: pendingApproval.id,
      data: { decision: 'approved', expectedVersion: pendingApproval.version },
    },
  );
  assert.equal(
    buildApprovalDecisionPayload(
      pendingApproval,
      { canDecide: false, loading: false },
      'approved',
    ),
    null,
  );
});

test('missing or invalid approval versions fail closed', () => {
  for (const version of [undefined, null, 0, -1, 1.5, '3']) {
    const availability = getApprovalActionAvailability(
      { ...pendingApproval, version },
      { canDecide: true, loading: false },
    );
    assert.equal(availability.canAct, false);
    assert.equal(availability.reason, APPROVAL_VERSION_MESSAGE);
  }
});

test('403, conflict, and network failures produce explicit review notices', () => {
  assert.match(
    getApprovalMutationErrorMessage({ status: 403 }),
    /API 403.*current governance-approved specialist assignment/,
  );
  assert.equal(
    getApprovalMutationErrorMessage({ status: 409 }),
    APPROVAL_STALE_MESSAGE,
  );
  assert.match(
    getApprovalMutationErrorMessage(new TypeError('Failed to fetch')),
    /Network error while submitting this review/,
  );
});

test('refresh invalidates every dependent view without resubmitting', async () => {
  const keys = getApprovalRefreshQueryKeys(pendingApproval);
  const invalidated: readonly unknown[][] = [];
  const queryClient = {
    invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
      invalidated.push(queryKey);
    },
  };

  await refreshApprovalViews(queryClient, pendingApproval);

  assert.equal(invalidated.length, 5);
  assert.deepEqual(invalidated[0], ['/api/onboarding/approvals']);
  assert.ok(invalidated.some((key) => key[0] === '/api/onboarding/approvals/7/history'));
  assert.ok(invalidated.some((key) => key[0] === '/api/onboarding/cases/42'));
  assert.ok(invalidated.some((key) => key[0] === '/api/onboarding/cases/42/events'));
  assert.ok(invalidated.some((key) => key[0] === '/api/onboarding/cases/42/readiness-sla'));
  assert.equal(keys.length, invalidated.length);
});

test('approval polling stops once the finite queue has no pending reviews', () => {
  assert.equal(getApprovalRefetchInterval([pendingApproval]), 5000);
  assert.equal(
    getApprovalRefetchInterval([{ ...pendingApproval, status: 'approved' }]),
    false,
  );
  assert.equal(getApprovalRefetchInterval(undefined), false);
});