import { useEffect, useState } from "react";
import { getPinnedOrganizationIdForPage } from "@workspace/api-client-react";

type OrganizationMembershipResponse = {
  activeOrganizationId: string | null;
  memberships: Array<{ organizationId: string; role: string }>;
  demoProfile?: "reviewer" | "administrator" | null;
  developmentSuperAdmin?: boolean;
  platformSuperAdmin?: boolean;
};

export function useOrganizationRole() {
  const [role, setRole] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [demoProfile, setDemoProfile] = useState<"reviewer" | "administrator" | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // Determine the pinned/active org ID directly (similar to organization-switcher logic)
    let pinnedOrgId: string | null = null;
    try {
      pinnedOrgId = getPinnedOrganizationIdForPage() || localStorage.getItem("activeOrganizationId");
    } catch {}

    fetch("/api/organizations/current", {
      credentials: "include",
      signal: controller.signal,
      headers: pinnedOrgId ? { "x-organization-id": pinnedOrgId } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load organization membership");
        return response.json() as Promise<OrganizationMembershipResponse>;
      })
      .then((data) => {
        setIsSuperAdmin(data.platformSuperAdmin === true || data.developmentSuperAdmin === true);
        const orgId = pinnedOrgId || data.activeOrganizationId;
        // A different workspace's membership must never grant this page actions.
        const membership = data.memberships.find((m) => m.organizationId === orgId);
        setOrganizationId(membership?.organizationId ?? null);
        setRole(membership?.role || null);
        setDemoProfile(data.demoProfile ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRole(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return { 
    role,
    organizationId,
    demoProfile,
    isHR: role === 'owner' || role === 'admin',
    isSuperAdmin,
    loading 
  };
}
