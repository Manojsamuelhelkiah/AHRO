import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getPinnedOrganizationIdForPage, invalidateProtectedResponses,
  setApiResponseObserver,
} from "@workspace/api-client-react";

/**
 * Protected data mounts only after a fresh server session check. Privilege
 * transitions remount descendants and fence even non-cancellable late fetches.
 * A local expiry timer closes the view without waiting for the next poll.
 */
export function ProtectedSessionBoundary({ children }: { children: ReactNode }) {
  const { userId, sessionId } = useAuth();
  const client = useQueryClient();
  const [state, setState] = useState<{ owner: string; stamp: string; revision: number } | null>(null);
  const owner = `${userId || ""}:${sessionId || ""}`;
  useEffect(() => {
    let live = true;
    let stamp: string | null = null;
    let revision = 0;
    let checking = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    function clear() {
      invalidateProtectedResponses();
      void client.cancelQueries();
      client.clear();
      if (live) setState(null);
    }
    clear();
    setApiResponseObserver((response) => {
      if (!stamp?.startsWith("admin:")) return;
      const expiry = Number(response.headers.get("X-Platform-Admin-Expires-At"));
      if (expiry <= Date.now() || response.status === 401) {
        stamp = null;
        clear();
        void check();
      }
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
        if (!response.ok) throw new Error("Session access could not be verified.");
        const body = await response.json();
        if (!live) return;
        const active = body.platformSuperAdmin === true || body.developmentSuperAdmin === true;
        const expiresAt = Number(response.headers.get("X-Platform-Admin-Expires-At"));
        // An active claim without a verifiable lifetime is not usable.
        if (active && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("Session expired.");
        const next = active ? `admin:${expiresAt}` : "ordinary";
        if (stamp !== next) {
          clear();
          stamp = next;
          revision += 1;
          setState({ owner, stamp: next, revision });
        }
        clearTimeout(expiryTimer);
        if (active) expiryTimer = setTimeout(() => {
          stamp = null;
          clear();
          void check();
        }, Math.min(expiresAt - Date.now(), 2_147_483_647));
      } catch {
        if (live) { stamp = null; clear(); }
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
  if (!state || state.owner !== owner) return <p role="status" className="p-6 text-sm">
    Checking session access. If access has expired, verify again or sign out before viewing protected records.
  </p>;
  return <div key={`${owner}:${state.stamp}:${state.revision}`}>{children}</div>;
}
