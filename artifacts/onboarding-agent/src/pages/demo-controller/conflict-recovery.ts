export type DemoRunRefetchResult = {
  data?: { version: number } | null;
};

export type DemoActionConflictRecovery = {
  handled: boolean;
  message: string | null;
};

export async function recoverDemoActionConflict(
  error: any,
  clearLastAttempt: () => void,
  refetch: () => Promise<DemoRunRefetchResult>,
): Promise<DemoActionConflictRecovery> {
  const status = error?.status ?? error?.response?.status;
  const serverMessage = typeof error?.data?.error === 'string'
    ? error.data.error
    : typeof error?.data?.message === 'string'
      ? error.data.message
      : null;

  if (status !== 409 || !serverMessage?.startsWith('Run changed since version ')) {
    return { handled: false, message: serverMessage };
  }

  clearLastAttempt();
  const refreshed = await refetch();
  return {
    handled: true,
    message: refreshed.data
      ? "This run changed before the action was applied. The latest state is now loaded; review it and try the action again."
      : "This run changed before the action was applied, but the latest state could not be loaded. Use Refresh and try again.",
  };
}