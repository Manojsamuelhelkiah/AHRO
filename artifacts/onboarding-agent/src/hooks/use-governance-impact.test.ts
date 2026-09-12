import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  governanceCaseImpactQuery,
  governanceRebaseInvalidationKeys,
  type GovernanceCaseImpactResponse,
} from './use-governance-impact';

test('governance impact adapter reads the documented snapshot and impacts envelope', async () => {
  const response: GovernanceCaseImpactResponse = {
    snapshot: {
      schemaVersion: 'governance-case-snapshot/v1',
      version: 3,
      adoptedAt: '2026-03-01T12:00:00.000Z',
      decisions: [{
        key: 'GD-04',
        revision: 2,
        status: 'approved',
        domain: 'legal',
        impactedWorkflows: ['background-verification'],
      }],
    },
    impacts: [{
      key: 'GD-04',
      adoptedRevision: 2,
      currentRevision: 3,
      impactedWorkflows: ['background-verification'],
      reason: 'revision-available',
      blocksLiveActions: false,
    }],
  };
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = String(init?.method);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const query = governanceCaseImpactQuery(42);
    const result = await query.queryFn({} as never);
    assert.deepEqual(query.queryKey, ['/api/onboarding/cases/42/governance-impact']);
    assert.equal(requestedUrl, '/api/onboarding/cases/42/governance-impact');
    assert.equal(requestedMethod, 'GET');
    assert.equal(result.snapshot?.version, 3);
    assert.deepEqual(result.impacts[0], response.impacts[0]);
    assert.equal('currentSnapshotVersion' in result, false);
    assert.equal('rebaseRequired' in result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('governance rebase refreshes the actual generated case and event query keys', () => {
  assert.deepEqual(governanceRebaseInvalidationKeys(42), [
    ['/api/onboarding/cases/42/governance-impact'],
    ['/api/onboarding/cases/42'],
    ['/api/onboarding/cases/42/readiness-sla'],
    ['/api/onboarding/cases/42/events'],
    ['/api/onboarding/cases'],
  ]);
});