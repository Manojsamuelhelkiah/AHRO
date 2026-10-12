/** Name is only a selection hint; callers must still verify the target ID. */
export function findNamedClientWorkspace(
  memberships: ReadonlyArray<{ organizationId: string; name: string }>,
  clientName: string,
): string | null {
  const name = clientName.trim().toLowerCase();
  if (!name) throw new Error("Enter a client name before opening its workspace.");
  const matches = memberships.filter(member => member.name.trim().toLowerCase() === name);
  if (matches.length > 1) throw new Error("More than one workspace has this client name. Select the intended client from Active workspace above.");
  return matches[0]?.organizationId ?? null;
}
export type OrganizationMembership = {
  organizationId: string;
};

export type OrganizationBootstrapResponse = {
  needsSetup: boolean;
  activeOrganizationId: string | null;
  memberships: OrganizationMembership[];
};

export type OrganizationBootstrapDecision =
  | { kind: 'setup' }
  | { kind: 'choose' }
  | { kind: 'ready'; organizationId: string; selectorChanged: boolean };

export type OrganizationSwitchDecision =
  | { kind: 'ready'; organizationId: string }
  | {
      kind: 'rejected';
      organizationId: string;
      reason: 'invalid-target' | 'not-member' | 'no-membership';
    };

export function resolveOrganizationBootstrap(
  response: OrganizationBootstrapResponse,
  storedOrganizationId: string | null,
): OrganizationBootstrapDecision {
  if (response.needsSetup || response.memberships.length === 0) {
    return { kind: 'setup' };
  }

  const storedMembership = storedOrganizationId
    ? response.memberships.find(({ organizationId }) => organizationId === storedOrganizationId)
    : undefined;
  const activeMembership = response.activeOrganizationId
    ? response.memberships.find(
        ({ organizationId }) => organizationId === response.activeOrganizationId,
      )
    : undefined;
  // Never silently choose a client when a person belongs to several. A
  // revoked/stale saved selector also requires a fresh explicit choice.
  const selected = storedMembership ?? activeMembership ??
    (response.memberships.length === 1 ? response.memberships[0] : undefined);
  if (!selected) return { kind: 'choose' };

  return {
    kind: 'ready',
    organizationId: selected.organizationId,
    selectorChanged: selected.organizationId !== storedOrganizationId,
  };
}

/**
 * A workspace switch is only allowed after the server has returned the
 * memberships for that exact target request.  In particular, an otherwise
 * successful response with activeOrganizationId === null is not evidence
 * that the requested workspace is still available: the current endpoint
 * returns that shape when a requested membership is stale or revoked.
 *
 * This helper deliberately does not mutate the persisted selector or the
 * page request scope.  Callers can therefore leave the mounted page on its
 * old tenant until a full reload has completed.
 */
export function resolveOrganizationSwitch(
  response: OrganizationBootstrapResponse,
  targetOrganizationId: string,
): OrganizationSwitchDecision {
  const organizationId = targetOrganizationId.trim();
  if (!organizationId) {
    return {
      kind: 'rejected',
      organizationId: targetOrganizationId,
      reason: 'invalid-target',
    };
  }

  if (response.needsSetup || response.memberships.length === 0) {
    return {
      kind: 'rejected',
      organizationId,
      reason: 'no-membership',
    };
  }

  const isMember = response.memberships.some(
    (membership) => membership.organizationId === organizationId,
  );
  if (!isMember) {
    return {
      kind: 'rejected',
      organizationId,
      reason: 'not-member',
    };
  }

  if (response.activeOrganizationId !== organizationId) {
    return {
      kind: 'rejected',
      organizationId,
      reason: 'not-member',
    };
  }

  return { kind: 'ready', organizationId };
}