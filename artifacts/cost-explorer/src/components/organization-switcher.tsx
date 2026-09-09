import { useEffect, useState } from "react";

type Membership = {
  organizationId: string;
  name: string;
  role: string;
};

type CurrentOrganizationResponse = {
  activeOrganizationId: string | null;
  memberships: Membership[];
};

function storedOrganizationId(): string | null {
  try {
    return localStorage.getItem("activeOrganizationId");
  } catch {
    return null;
  }
}

export function OrganizationSwitcher() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedId, setSelectedId] = useState(storedOrganizationId);

  useEffect(() => {
    const stored = storedOrganizationId();
    fetch("/api/organizations/current", {
      credentials: "include",
      headers: stored ? { "x-organization-id": stored } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load workspaces");
        return response.json() as Promise<CurrentOrganizationResponse>;
      })
      .then((response) => {
        setMemberships(response.memberships);
        setSelectedId(
          response.memberships.find(({ organizationId }) => organizationId === stored)
            ?.organizationId
          ?? response.activeOrganizationId
          ?? response.memberships[0]?.organizationId
          ?? null,
        );
      })
      .catch(() => {
        // Bootstrap already presents the actionable organization-load error.
      });
  }, []);

  if (memberships.length < 2 || !selectedId) return null;

  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
        Active workspace
      </span>
      <select
        aria-label="Active workspace"
        value={selectedId}
        onChange={(event) => {
          localStorage.setItem("activeOrganizationId", event.target.value);
          window.location.reload();
        }}
        className="w-full rounded-md border border-sidebar-border bg-sidebar-accent px-2 py-2 text-xs font-medium text-sidebar-foreground outline-none focus:ring-2 focus:ring-primary"
      >
        {memberships.map((membership) => (
          <option key={membership.organizationId} value={membership.organizationId}>
            {membership.name}
          </option>
        ))}
      </select>
    </label>
  );
}