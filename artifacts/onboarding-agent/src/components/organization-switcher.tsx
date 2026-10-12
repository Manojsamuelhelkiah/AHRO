import { useEffect, useRef, useState } from "react";
import { CreateClientDialog } from "./create-client-dialog";
import {
  resolveOrganizationBootstrap,
  resolveOrganizationSwitch,
  type OrganizationBootstrapResponse,
  type OrganizationMembership,
} from "../lib/organization-bootstrap";

type Membership = OrganizationMembership & {
  name: string;
  role: string;
};

type CurrentOrganizationResponse = OrganizationBootstrapResponse & {
  memberships: Membership[];
  developmentSuperAdmin?: boolean;
  platformSuperAdmin?: boolean;
  platformAdminMode?: "private" | "development" | null;
};

function storedOrganizationId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("activeOrganizationId");
  } catch {
    return null;
  }
}

function currentOrganizationResponse(value: unknown): CurrentOrganizationResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Could not load workspaces");
  }

  const response = value as Partial<CurrentOrganizationResponse>;
  if (
    typeof response.needsSetup !== "boolean" ||
    (response.activeOrganizationId !== null &&
      typeof response.activeOrganizationId !== "string") ||
    !Array.isArray(response.memberships)
  ) {
    throw new Error("Could not load workspaces");
  }

  return response as CurrentOrganizationResponse;
}

async function responseError(response: Response, action: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  const message =
    body &&
    typeof body === "object" &&
    typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message.trim()
      : "";
  const detail = message || response.statusText || `HTTP ${response.status}`;
  return new Error(`${action}: ${detail}`);
}

function switchRejectionMessage(
  reason: "invalid-target" | "not-member" | "no-membership",
): string {
  if (reason === "not-member") {
    return "You no longer have access to that workspace.";
  }
  if (reason === "no-membership") {
    return "This account has no active workspace membership.";
  }
  return "Choose a valid workspace.";
}

export function OrganizationSwitcher() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedId, setSelectedId] = useState(storedOrganizationId);
  const [pendingOrganizationId, setPendingOrganizationId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [adminMode, setAdminMode] = useState<"private" | "development" | null>(null);
  const [creating, setCreating] = useState(false);
  const pendingOrganizationRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const stored = storedOrganizationId();
    fetch("/api/organizations/current", {
      credentials: "include",
      headers: stored ? { "x-organization-id": stored } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw await responseError(response, "Could not load workspaces");
        }
        return currentOrganizationResponse(await response.json());
      })
      .then((response) => {
        if (!active) return;
        setMemberships(response.memberships);
        setIsSuperAdmin(response.platformSuperAdmin === true || response.developmentSuperAdmin === true);
        setAdminMode(response.platformAdminMode ?? (response.developmentSuperAdmin ? "development" : null));
        const decision = resolveOrganizationBootstrap(response, stored);
        setSelectedId(decision.kind === "ready" ? decision.organizationId : null);
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : "Could not load client identity");
      });

    return () => {
      active = false;
      mountedRef.current = false;
      pendingOrganizationRef.current = null;
    };
  }, []);

  if (!selectedId || memberships.length === 0) return <span role={error ? "alert" : "status"} className="text-xs text-[var(--text-muted)]">{error || "Loading client…"}</span>;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
    <label className="min-w-0 max-w-[240px] flex-1">
      <span className="block text-[10px] font-semibold uppercase text-[var(--text-muted)]">Active client / workspace</span>
      <span className="block break-words text-xs font-semibold" data-testid="active-client-name">{memberships.find(membership => membership.organizationId === selectedId)?.name}</span>
      <select
        aria-label="Active workspace"
        title={memberships.find(membership => membership.organizationId === selectedId)?.name}
        value={selectedId}
        disabled={pendingOrganizationId !== null}
        aria-busy={pendingOrganizationId !== null}
        onChange={async (event) => {
          const targetOrganizationId = event.target.value;
          if (
            pendingOrganizationRef.current !== null ||
            targetOrganizationId === selectedId
          ) {
            return;
          }

          // Keep the controlled value on the old tenant while validating.  A
          // mounted page must not appear to switch before its full reload.
          pendingOrganizationRef.current = targetOrganizationId;
          setPendingOrganizationId(targetOrganizationId);
          setError(null);

          try {
            const response = await fetch("/api/organizations/current", {
              credentials: "include",
              headers: { "x-organization-id": targetOrganizationId },
            });
            if (!response.ok) {
              throw await responseError(response, "Could not validate workspace switch");
            }

            const decision = resolveOrganizationSwitch(
              currentOrganizationResponse(await response.json()),
              targetOrganizationId,
            );
            if (decision.kind === "rejected") {
              throw new Error(switchRejectionMessage(decision.reason));
            }
            if (
              !mountedRef.current ||
              pendingOrganizationRef.current !== targetOrganizationId
            ) {
              return;
            }

            // Validation succeeded for this exact target.  The page request
            // scope is intentionally not repinned here; reload creates the
            // next page realm and pins it during bootstrap.
            const previousOrganizationId = storedOrganizationId();
            try {
              window.localStorage.setItem(
                "activeOrganizationId",
                decision.organizationId,
              );
            } catch {
              throw new Error("Could not save the selected workspace");
            }
            try {
              window.location.reload();
            } catch (caught) {
              // A browser reload normally does not throw, but preserving the
              // old selector keeps a failed navigation from changing tenant
              // state if a host shell intercepts it.
              try {
                if (previousOrganizationId) {
                  window.localStorage.setItem(
                    "activeOrganizationId",
                    previousOrganizationId,
                  );
                } else {
                  window.localStorage.removeItem("activeOrganizationId");
                }
              } catch {
                // The original navigation error is the actionable failure.
              }
              throw caught;
            }
          } catch (caught) {
            if (
              mountedRef.current &&
              pendingOrganizationRef.current === targetOrganizationId
            ) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not validate workspace switch",
              );
            }
          } finally {
            if (pendingOrganizationRef.current === targetOrganizationId) {
              pendingOrganizationRef.current = null;
              setPendingOrganizationId(null);
            }
          }
        }}
        className="h-8 w-full min-w-0 truncate rounded-md border px-2 text-xs font-semibold outline-none"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface-alt)",
          color: "var(--text-primary)",
        }}
      >
        {memberships.map((membership) => (
          <option key={membership.organizationId} value={membership.organizationId}>
            {membership.name}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="mt-1 block text-[11px] font-medium text-red-600">
          {error}
        </span>
      ) : null}
    </label>
    <span className="text-[10px] font-semibold text-[var(--text-secondary)]">{isSuperAdmin ? `Super Admin · ${adminMode === "private" ? "Private MFA session" : "Development"}` : memberships.find(membership => membership.organizationId === selectedId)?.role}</span>
    {isSuperAdmin && <button type="button" onClick={() => setCreating(true)} className="rounded border border-[var(--border)] px-2 py-1 text-xs" data-testid="button-create-client">New client</button>}
    {creating && <CreateClientDialog onClose={() => setCreating(false)} />}
    </div>
  );
}