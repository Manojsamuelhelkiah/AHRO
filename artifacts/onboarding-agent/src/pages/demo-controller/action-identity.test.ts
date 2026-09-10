import { getRequestIdForAction } from './action-identity';
import type { DemoRunAction } from '@workspace/api-client-react';

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
    expect(requestId).toBe('mock-uuid-1');
    expect(nextAttempt.payload).toEqual(payload);
    expect(nextAttempt.requestId).toBe('mock-uuid-1');
  });

  it('reuses the same ID for identical payloads', () => {
    const payload: Omit<DemoRunAction, 'requestId'> = {
      expectedVersion: 1,
      kind: 'advance'
    };
    
    const first = getRequestIdForAction(payload, null, () => 'fixed-id');
    const second = getRequestIdForAction(payload, first.nextAttempt, () => 'should-not-use');
    
    expect(second.requestId).toBe('fixed-id');
    expect(second.nextAttempt).toEqual(first.nextAttempt);
  });

  it('generates a new ID when version changes', () => {
    const payload1: Omit<DemoRunAction, 'requestId'> = { expectedVersion: 1, kind: 'advance' };
    const payload2: Omit<DemoRunAction, 'requestId'> = { expectedVersion: 2, kind: 'advance' };
    
    const first = getRequestIdForAction(payload1, null, () => 'id-1');
    const second = getRequestIdForAction(payload2, first.nextAttempt, () => 'id-2');
    
    expect(second.requestId).toBe('id-2');
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
    
    expect(second.requestId).toBe('id-2');
  });
});
