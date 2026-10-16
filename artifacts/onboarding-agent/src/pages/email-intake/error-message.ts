/** Server-owned explanations only; never show raw HTML, source mail or stack traces. */
export function emailIntakeErrorMessage(e: unknown): string {
  const x = e as { status?: number; response?: { status?: number }; data?: { message?: unknown } };
  const status = x?.status ?? x?.response?.status;
  if (status === 403) return 'You do not have permission for this action in this workspace.';
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 404) return 'This item was not found or is not visible to you.';
  if (status === 429) return 'Too many requests. Wait a moment and retry.';
  const message = x?.data?.message;
  const safeMessage = typeof message === 'string' && message.trim() && message.length <= 500 &&
    !/[<>]/.test(message) ? message : null;
  // 409 also covers routing, unreviewed fields, attachment acknowledgements and
  // duplicate safeguards. It does not imply an optimistic-lock conflict.
  if (status === 409) return safeMessage ?? 'This action is currently blocked. Reload the request to check its current requirements.';
  return safeMessage ?? 'The request could not be completed. Retry, or contact an administrator if it persists.';
}
