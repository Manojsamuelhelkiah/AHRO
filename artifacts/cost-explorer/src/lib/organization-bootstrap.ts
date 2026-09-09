export type OrganizationMembership = {
  organizationId: string;
};

export type OrganizationBootstrapResponse = {
  needsSetup: boolean;
  activeOrganizationId: string | null;
  memberships: OrganizationMembership[];
};

export type OrganizationBootstrapDecision =
  | { kind: "setup" }
  | { kind: "ready"; organizationId: string; selectorChanged: boolean };

export function resolveOrganizationBootstrap(
  response: OrganizationBootstrapResponse,
  storedOrganizationId: string | null,
): OrganizationBootstrapDecision {
  if (response.needsSetup || response.memberships.length === 0) {
    return { kind: "setup" };
  }

  const storedMembership = storedOrganizationId
    ? response.memberships.find(({ organizationId }) => organizationId === storedOrganizationId)
    : undefined;
  const activeMembership = response.activeOrganizationId
    ? response.memberships.find(
        ({ organizationId }) => organizationId === response.activeOrganizationId,
      )
    : undefined;
  const selected = storedMembership ?? activeMembership ?? response.memberships[0];

  return {
    kind: "ready",
    organizationId: selected.organizationId,
    selectorChanged: selected.organizationId !== storedOrganizationId,
  };
}