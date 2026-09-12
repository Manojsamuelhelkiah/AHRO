const GOVERNANCE_DISPATCH_BLOCKED_MESSAGE =
  "Governance changes are blocked while a provider dispatch is active or ambiguous.";

export async function lockGovernanceMutation(client, organizationId) {
  // Match the application membership lifecycle fence before taking the
  // namespaced governance dispatch fence. Both are transaction-scoped.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [organizationId],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`governance-dispatch-mutation:${organizationId}`],
  );
  const activeDispatch = await client.query(
    `SELECT 1
       FROM onb_governance_dispatch_markers
      WHERE organization_id = $1
        AND status IN ('dispatching', 'ambiguous')
      LIMIT 1`,
    [organizationId],
  );
  if (activeDispatch.rowCount) {
    const error = new Error(GOVERNANCE_DISPATCH_BLOCKED_MESSAGE);
    error.code = "GOVERNANCE_DISPATCH_IN_FLIGHT";
    throw error;
  }
}

export async function lockActiveBootstrapMembership(
  client,
  organizationId,
  userId,
) {
  const member = await client.query(
    `SELECT id, role
       FROM organization_memberships
      WHERE organization_id = $1
        AND clerk_user_id = $2
        AND revoked_at IS NULL
      FOR UPDATE`,
    [organizationId, userId],
  );
  if (!member.rowCount) {
    const error = new Error("Bootstrap authority administrator must be an active tenant member.");
    error.code = "ORGANIZATION_MEMBERSHIP_REVOKED";
    throw error;
  }
  return member.rows[0];
}