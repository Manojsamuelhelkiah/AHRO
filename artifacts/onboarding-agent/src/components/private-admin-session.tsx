import { useEffect, useState } from "react";
import { useAuth, useClerk, useReverification } from "@clerk/react";
import type { PrivateAdminEligibility } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { compactAccountControls } from "./case-account-presentation";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function PrivateAdminSession() {
  const [location] = useLocation();
  const clerk = useClerk();
  const { userId, sessionId } = useAuth();
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [identity, setIdentity] = useState<PrivateAdminEligibility | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setEligible(false);
    setIdentity(null);
    setError("");
    fetch(`${base}/api/platform-admin/session`, { credentials: "include", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Private administrator eligibility could not be verified.");
        const result = await response.json() as PrivateAdminEligibility;
        if (controller.signal.aborted) return;
        setIdentity(result);
        setEligible(result.eligible === true);
      })
      .catch(caught => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [userId, sessionId]);
  const activate = useReverification(async () => {
    const response = await fetch(`${base}/api/platform-admin/session`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    });
    const result = await response.json();
    // Return the standard hint so Clerk opens its multi-factor modal and retries.
    if (result.clerk_error) return result;
    if (!response.ok) throw result;
    return result;
  });
  async function start() {
    setBusy(true); setError("");
    try {
      const result = await activate();
      if (result?.active) window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message :
        (caught as { message?: string })?.message || "Administrator verification was not completed.");
    } finally { setBusy(false); }
  }
  async function end() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}/api/platform-admin/session`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error("Could not revoke this session. Try again; access has not been confirmed ended.");
      await clerk.signOut();
      window.location.href = base || "/";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not end administrator access.");
      setBusy(false);
    }
  }
  // Accessible before tenant setup, and after a privilege expires/revokes.
  const controls = <>
      <div className="flex flex-wrap items-center gap-3">
        <span>{eligible ? "Eligible for private administrator access · verify to activate a 15-minute session · independent safeguards apply" : "Platform access requires private approval of your verified MFA account."}</span>
        {eligible && <button type="button" onClick={() => void start()} disabled={busy}
          className="rounded border px-2 py-1 font-semibold" data-testid="private-admin-activate">
          {busy ? "Verifying…" : "Verify / renew administrator access"}
        </button>}
        <button type="button" onClick={() => clerk.openUserProfile()} className="rounded border px-2 py-1">
          Account security / MFA
        </button>
        <button type="button" onClick={() => void end()} disabled={busy} className="rounded border px-2 py-1">
          End session
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
      {identity && <details className="mt-1">
        <summary className="cursor-pointer">Your provider identity for private operator approval</summary>
        <p>User ID: <code>{identity.userId}</code> · Primary email ID: <code>{identity.primaryEmailId || "not set"}</code></p>
        <p>Primary email {identity.primaryEmailVerified ? "verified" : "not verified"} · MFA {identity.mfaEnrolled ? "enrolled" : "not enrolled"}.
          These checks do not grant platform administration.</p>
      </details>}
  </>;
  const compact = compactAccountControls(location, eligible, error);
  return <aside id="private-admin-session" className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs" aria-label="Private administrator session">
    {compact ? <details><summary className="cursor-pointer">Account security and administrator access</summary>
      <div className="mt-2">{controls}</div>
    </details> : controls}
  </aside>;
}
