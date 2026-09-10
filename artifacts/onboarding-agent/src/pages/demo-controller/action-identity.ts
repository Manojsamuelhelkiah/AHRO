import type { DemoRunAction } from '@workspace/api-client-react';

export function getRequestIdForAction(
  newPayload: Omit<DemoRunAction, 'requestId'>,
  lastAttempt: { payload: Omit<DemoRunAction, 'requestId'>; requestId: string } | null,
  generateUuid: () => string = () => crypto.randomUUID()
): { requestId: string; nextAttempt: { payload: Omit<DemoRunAction, 'requestId'>; requestId: string } } {
  if (!lastAttempt) {
    const requestId = generateUuid();
    return { requestId, nextAttempt: { payload: newPayload, requestId } };
  }

  // Simple deep equals for the payload objects
  const isSame = JSON.stringify(newPayload) === JSON.stringify(lastAttempt.payload);
  
  if (isSame) {
    return { requestId: lastAttempt.requestId, nextAttempt: lastAttempt };
  }

  const requestId = generateUuid();
  return { requestId, nextAttempt: { payload: newPayload, requestId } };
}
