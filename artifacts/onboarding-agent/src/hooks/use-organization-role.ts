import { useEffect, useState } from "react";
import { getPinnedOrganizationIdForPage } from "@workspace/api-client-react";

type OrganizationMembershipResponse = {
  activeOrganizationId: string | null;
  memberships: Array<{ organizationId: string; role: string }>;
};

export function useOrganizationRole() {
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        const orgId = pinnedOrgId || data.activeOrganizationId;
        // A different workspace's membership must never grant this page actions.
        const membership = data.memberships.find((m) => m.organizationId === orgId);
        setRole(membership?.role || null);
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
    isHR: role === 'owner' || role === 'admin',
    loading 
  };
}
