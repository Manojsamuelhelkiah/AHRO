import { getRequestIdForAction } from './action-identity';
import type { DemoRunAction } from '@workspace/api-client-react';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recoverDemoActionConflict } from './conflict-recovery';

const mockGenerateId = (() => {
  let count = 0;
  return () => `mock-uuid-${++count}`;
})();

describe('getRequestIdForAction', () => {
  it('generates a new ID for the first action', () => {
    const payload: Omit<DemoRunAction, 'requestId'> = {
      expectedVersion: 1,
      kind: 'advance'
    };
    
    const { requestId, nextAttempt } = getRequestIdForAction(payload, null, mockGenerateId);
    assert.equal(requestId, 'mock-uuid-1');
    assert.deepEqual(nextAttempt.payload, payload);
    assert.equal(nextAttempt.requestId, 'mock-uuid-1');
  });

  it('reuses the same ID for identical payloads', () => {
    const payload: Omit<DemoRunAction, 'requestId'> = {
      expectedVersion: 1,
      kind: 'advance'
    };
    
    const first = getRequestIdForAction(payload, null, () => 'fixed-id');
    const second = getRequestIdForAction(payload, first.nextAttempt, () => 'should-not-use');
    
    assert.equal(second.requestId, 'fixed-id');
    assert.deepEqual(second.nextAttempt, first.nextAttempt);
  });

  it('generates a new ID when version changes', () => {
    const payload1: Omit<DemoRunAction, 'requestId'> = { expectedVersion: 1, kind: 'advance' };
    const payload2: Omit<DemoRunAction, 'requestId'> = { expectedVersion: 2, kind: 'advance' };
    
    const first = getRequestIdForAction(payload1, null, () => 'id-1');
    const second = getRequestIdForAction(payload2, first.nextAttempt, () => 'id-2');
    
    assert.equal(second.requestId, 'id-2');
  });

  it('generates a new ID when action properties change', () => {
    const payload1: Omit<DemoRunAction, 'requestId'> = { 
      expectedVersion: 1, 
      kind: 'communication',
      channel: 'email',
      mode: 'live'
    };
    const payload2: Omit<DemoRunAction, 'requestId'> = { 
      expectedVersion: 1, 
      kind: 'communication',
      channel: 'email',
      mode: 'simulated' // Changed
    };
    
    const first = getRequestIdForAction(payload1, null, () => 'id-1');
    const second = getRequestIdForAction(payload2, first.nextAttempt, () => 'id-2');
    
    assert.equal(second.requestId, 'id-2');
  });
});

describe('Demo run action conflict recovery', () => {
  it('refetches a stale run and creates a safe retry for the latest version', async () => {
    const stalePayload: Omit<DemoRunAction, 'requestId'> = {
      expectedVersion: 4,
      kind: 'advance',
    };
    const first = getRequestIdForAction(stalePayload, null, () => 'stale-request');
    let lastAttempt = first.nextAttempt;
    let refetchCount = 0;

    const recovery = await recoverDemoActionConflict(
      {
        status: 409,
        data: { error: 'Run changed since version 4. Current version is 5.' },
      },
      () => {
        lastAttempt = null as any;
      },
      async () => {
        refetchCount += 1;
        return { data: { version: 5 } };
      },
    );

    assert.equal(recovery.handled, true);
    assert.equal(refetchCount, 1);
    assert.match(recovery.message!, /latest state is now loaded/);

    const retry = getRequestIdForAction(
      { expectedVersion: 5, kind: 'advance' },
      lastAttempt,
      () => 'retry-request',
    );
    assert.equal(retry.requestId, 'retry-request');
    assert.equal(retry.nextAttempt.payload.expectedVersion, 5);
  });

  it('shows a non-version 409 reason without treating it as a stale run', async () => {
    let cleared = false;
    let refetched = false;
    const serverReason = 'The selected volunteer is no longer available.';

    const recovery = await recoverDemoActionConflict(
      { response: { status: 409 }, data: { error: serverReason } },
      () => {
        cleared = true;
      },
      async () => {
        refetched = true;
        return { data: { version: 5 } };
      },
    );

    assert.deepEqual(recovery, { handled: false, message: serverReason });
    assert.equal(cleared, false);
    assert.equal(refetched, false);
  });
});
