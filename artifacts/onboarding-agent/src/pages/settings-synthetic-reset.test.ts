import assert from 'node:assert/strict';
import test from 'node:test';
import { pinOrganizationIdForPage } from '@workspace/api-client-react';
import {
  SYNTHETIC_RESET_CONFIRMATION,
  SYNTHETIC_RESET_PATH,
  FRESH_EXAMPLES,
  canSubmitSyntheticReset,
  getSyntheticResetStatus,
  postSyntheticReset,
  syntheticResetErrorMessage,
} from './settings-synthetic-reset';

test('fresh examples match the backend synthetic seed scenarios', () => {
  assert.deepEqual(FRESH_EXAMPLES, [
    'Standard external hire',
    'Contractor/client project',
    'Rehire',
    'Internal transfer',
    'Background-check exception',
    'Critical-skill hire',
  ]);
});

test('synthetic reset requires fresh ready data and exact confirmation', () => {
  const data = {
    organizationId: 'org-a',
    status: 'ready' as const,
    revision: 'revision-1',
    candidates: [],
    preservedCount: 4,
    replacementCount: 6,
    blockers: [],
    receipt: null,
  };

  assert.equal(
    canSubmitSyntheticReset({
      data,
      organizationId: 'org-a',
      isFetching: false,
      confirmation: SYNTHETIC_RESET_CONFIRMATION,
      isFetched: true,
    }),
    true,
  );
  assert.equal(
    canSubmitSyntheticReset({
      data,
      organizationId: 'org-a',
      isFetching: true,
      confirmation: SYNTHETIC_RESET_CONFIRMATION,
      isFetched: true,
    }),
    false,
  );
  assert.equal(
    canSubmitSyntheticReset({
      data,
      organizationId: 'org-a',
      isFetching: false,
      confirmation: ` ${SYNTHETIC_RESET_CONFIRMATION}`,
      isFetched: true,
    }),
    false,
  );
  assert.equal(
    canSubmitSyntheticReset({
      data,
      organizationId: 'org-b',
      isFetching: false,
      confirmation: SYNTHETIC_RESET_CONFIRMATION,
      isFetched: true,
    }),
    false,
  );
  assert.equal(
    canSubmitSyntheticReset({
      data,
      organizationId: 'org-a',
      isFetching: false,
      confirmation: SYNTHETIC_RESET_CONFIRMATION,
      isFetched: true,
      statusNeedsRefresh: true,
    }),
    false,
  );
});

test('synthetic reset requests stay on the pinned workspace and exact endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; organizationId: string | null; body: string }> = [];
  pinOrganizationIdForPage('org-a');
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      organizationId: new Headers(init?.headers).get('x-organization-id'),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(
      JSON.stringify({
        organizationId: 'org-a',
        status: 'completed',
        revision: 'revision-2',
        candidates: [],
        preservedCount: 4,
        replacementCount: 6,
        blockers: [],
        receipt: { deletedCaseIds: [1], createdCaseIds: [2], completedAt: '2026-01-01T00:00:00.000Z' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
  });

  await getSyntheticResetStatus({ organizationId: 'org-a' });
  await postSyntheticReset({ organizationId: 'org-a', expectedRevision: 'revision-1' });

  assert.deepEqual(
    requests.map(({ url, method, organizationId }) => ({ url, method, organizationId })),
    [
      { url: SYNTHETIC_RESET_PATH, method: 'GET', organizationId: 'org-a' },
      { url: SYNTHETIC_RESET_PATH, method: 'POST', organizationId: 'org-a' },
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].body), {
    expectedRevision: 'revision-1',
    confirmation: SYNTHETIC_RESET_CONFIRMATION,
  });
});

test('stale and authorization failures explain the safe next action', () => {
  assert.match(syntheticResetErrorMessage({ status: 403 }), /owners and admins/i);
  assert.match(syntheticResetErrorMessage({ status: 409 }), /Refresh the status/i);
  assert.match(syntheticResetErrorMessage({ status: 409 }), /nothing was submitted automatically/i);
});