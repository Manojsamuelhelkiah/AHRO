import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getPinnedOrganizationIdForPage, invalidateProtectedResponses,
  setApiResponseObserver,
} from "@workspace/api-client-react";
import { SessionAccessNotice } from "./session-access-notice";

/**
 * Protected data mounts only after a fresh server session check. Privilege
 * transitions remount descendants and fence even non-cancellable late fetches.
 * A local expiry timer closes the view without waiting for the next poll.
 */
export function ProtectedSessionBoundary({ children }: { children: ReactNode }) {
  const { userId, sessionId } = useAuth();
  const client = useQueryClient();
  const [state, setState] = useState<{ owner: string; stamp: string; revision: number } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const owner = `${userId || ""}:${sessionId || ""}`;
  useEffect(() => {
    let live = true;
    let stamp: string | null = null;
    let revision = 0;
    let accessEpoch = 0;
    let checking = false;
    let wasAdministrator = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    function clear() {
      accessEpoch += 1;
      invalidateProtectedResponses();
      void client.cancelQueries();
      client.clear();
      if (live) setState(null);
    }
    clear();
    setApiResponseObserver((response) => {
      if (!stamp?.startsWith("admin:")) return;
      const observedEpoch = accessEpoch;
      const header = response.headers.get("X-Platform-Admin-Expires-At");
      const expiry = header === null ? null : Number(header);
      // Missing headers on an unrelated response are not proof of expiry.
      // Explicit verification failures are; discard protected data immediately.
      if ((expiry !== null && expiry <= Date.now()) || response.status === 401) {
        stamp = null;
        clear();
        void check();
      }
      if (response.status === 403) void response.clone().json().then(body => {
        if (!live || observedEpoch !== accessEpoch ||
          !["ADMIN_GRANT_INVALID", "ADMIN_REVOKED", "ADMIN_MFA_REQUIRED"].includes(body.code)) return;
        stamp = null;
        clear();
        setFailure({ status: 403, data: body });
      }).catch(() => {});
    });
    async function check() {
      if (checking || !live) return;
      checking = true;
      try {
        const organizationId = getPinnedOrganizationIdForPage();
        const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/organizations/current`, {
          credentials: "include", cache: "no-store", signal: controller.signal,
          headers: organizationId ? { "x-organization-id": organizationId } : undefined,
        });
        if (!response.ok) throw { status: response.status, data: await response.json().catch(() => null) };
        const body = await response.json();
        if (!live) return;
        const active = body.platformSuperAdmin === true || body.developmentSuperAdmin === true;
        if (!active && wasAdministrator) throw { status: 403, data: { code: "ADMIN_GRANT_INVALID" } };
        const expiresAt = Number(response.headers.get("X-Platform-Admin-Expires-At"));
        // An active claim without a verifiable lifetime is not usable.
        if (active && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("Session expired.");
        const next = active ? `admin:${expiresAt}` : "ordinary";
        wasAdministrator = active;
        if (stamp !== next) {
          clear();
          stamp = next;
          revision += 1;
          setState({ owner, stamp: next, revision });
        }
        setFailure(null);
        clearTimeout(expiryTimer);
        if (active) expiryTimer = setTimeout(() => {
          stamp = null;
          clear();
          void check();
        }, Math.min(expiresAt - Date.now(), 2_147_483_647));
      } catch (error) {
        if (live) { stamp = null; clear(); setFailure(error); }
      } finally { checking = false; }
    }
    void check();
    const interval = setInterval(() => void check(), 15_000);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => {
      live = false;
      controller.abort();
      clearInterval(interval);
      clearTimeout(expiryTimer);
      window.removeEventListener("focus", focus);
      setApiResponseObserver(null);
      clear();
    };
  }, [owner, client]);
  if (!state || state.owner !== owner) return failure ? <SessionAccessNotice error={failure} /> : <p role="status" className="p-6 text-sm">
    Checking session access. If access has expired, verify again or sign out before viewing protected records.
  </p>;
  return <div key={`${owner}:${state.stamp}:${state.revision}`}>
    <p role="status" data-testid="current-session-access" className="px-4 py-2 text-xs text-[var(--text-muted)]">
      {state.stamp.startsWith("admin:") ? "Administrator access verified for this session." : "Ordinary account session; no active Super Admin verification."}
      {" "}Account initials identify the account only.
    </p>
    {children}
  </div>;
}
