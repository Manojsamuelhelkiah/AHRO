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
    <label className="min-w-0 max-w-[180px]">
      <span className="sr-only">Active workspace</span>
      <select
        aria-label="Active workspace"
        value={selectedId}
        onChange={(event) => {
          localStorage.setItem("activeOrganizationId", event.target.value);
          window.location.reload();
        }}
        className="h-8 w-full truncate rounded-md border px-2 text-xs font-semibold outline-none"
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
    </label>
  );
}