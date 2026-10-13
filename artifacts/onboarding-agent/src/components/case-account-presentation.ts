/** Presentation only: never changes session observation or record authorization. */
export const isCaseDetailPath = (path: string) => /^\/cases\/\d+\/?$/.test(path);

export function compactAccountControls(path: string, eligible: boolean, error: string) {
  // Verification/renewal and failures remain prominent when applicable.
  return isCaseDetailPath(path) && !eligible && !error;
}

export function accountSessionLabel(path: string, activeAdministrator: boolean) {
  if (activeAdministrator) return "Administrator access verified for this session.";
  return isCaseDetailPath(path) ? "Ordinary account · Administrator access not active." :
    "Ordinary account session; no active Super Admin verification.";
}
