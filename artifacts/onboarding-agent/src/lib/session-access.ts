type AccessError = { status?: number; data?: { code?: string }; response?: { status?: number } };

export function accessDenied(error: unknown) {
  const e = error as AccessError | null;
  return [401, 403].includes(e?.status ?? e?.response?.status ?? 0);
}

/** Only safe server codes determine the explanation, never identity labels. */
export function sessionAccessGuidance(error: unknown) {
  const e = error as AccessError | null;
  const code = e?.data?.code;
  if (code === "ADMIN_MFA_REQUIRED") return {
    message: "Administrator verification needs recent MFA. Use Verify / renew administrator access above.",
    renew: true,
  };
  if (code === "ADMIN_GRANT_INVALID" || code === "ADMIN_REVOKED") return {
    message: code === "ADMIN_REVOKED"
      ? "Administrator access was revoked or the session changed. Private operators must verify again; development Super Admin users must sign in again."
      : "Administrator verification expired or belongs to another session. Private operators must verify again; development Super Admin users must sign in again.",
    renew: true,
  };
  if (code === "EMAIL_INTAKE_DEMO_RESTRICTED") return {
    message: "Public Demo access cannot open Email Intake. Sign out, then choose Super Admin and enter its credentials. Account initials identify the account, not administrator access.",
    renew: false,
  };
  if (code?.startsWith("ORGANIZATION_")) return {
    message: "This session does not have access to the selected client. Select an accessible client workspace or ask its owner to restore your access.",
    renew: false,
  };
  if ((e?.status ?? e?.response?.status) === 401) return { message: "Your sign-in session ended. Sign in again.", renew: false };
  if (!accessDenied(error)) return {
    message: "Session verification is temporarily unavailable. Protected data stays hidden until the server confirms access. Try returning to this page when verification is available.",
    renew: false,
  };
  return {
    message: "Current permissions do not allow this view or action in the selected client. Ask the client owner to review your access. Account initials do not grant administrator access.",
    renew: false,
  };
}
