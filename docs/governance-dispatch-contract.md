# Governance dispatch fence contract

Any path that performs a real provider/external write based on governance
decisions, requirement coverage, or effective human permissions **must** wrap that
write in `withGovernanceDispatch`.

```ts
await withGovernanceDispatch(
  {
    organizationId,
    operation: "provider-action-name",
    adoptedCaseSnapshot: { caseId, adoptedGovernanceRevision },
    beforeDispatch: async ({ tx, fence }) => {
      // Evaluate authorization/pending-policy denial under the organization
      // fence lock BEFORE a durable provider marker exists.
      await authorizeProviderWrite(tx, fence);
    },
  },
  async (fence) => {
    // Persist/use fence only with the provider write. Do not re-read mutable
    // governance state and substitute it for this fenced snapshot.
    const result = await providerCall({ governanceFence: fence });
    return result.sent
      ? { disposition: "sent", value: result }
      : { disposition: "definitive-not-sent", value: result };
  },
);
```

The wrapper acquires the same per-organization PostgreSQL advisory lock used by
every governance mutation, snapshots current decision revisions, requirement
versions, and active verified authority assignments, and commits a durable
`dispatching` marker before callback I/O. The database transaction is not held
over the external call.

`beforeDispatch` rejection creates no marker: ordinary pending-policy denials
therefore do not permanently lock the organization. Provider callbacks must
return an explicit disposition: `sent`, `definitive-not-sent`, or `unknown`.
Only `sent` represents a provider write. `definitive-not-sent` finalizes the
marker but must not be reported as a successful send; `unknown` stays blocked.

While a marker is `dispatching` or `ambiguous`, governance mutations and
snapshot adoption/rebase must call `assertGovernanceMutationAllowed(tx,
organizationId)` under the same transaction and fail closed. A callback that
resolves normally finalizes its marker. A thrown callback, unknown provider
outcome, or process crash leaves a durable blocker; it is never automatically
reclaimed. Reconciliation must explicitly finalize it only after the external
outcome is established.

The optional `adoptedCaseSnapshot` is copied verbatim into the durable fence.
Case-bound callers must pass the case's already-adopted policy/governance
revision and must not replace it with today's current decision state.

This is deliberately an organization-wide conservative fence. It prevents a
final governance read from racing a provider write even where a caller's exact
decision/requirement dependency set is incomplete.

An ambiguous marker is durable until a server-verified operator records a
reconciliation reference through `POST /governance/dispatches/:dispatchId/reconcile`.
The UI should surface active/ambiguous fences as a blocked-live-action state;
ordinary tenant admins cannot clear them.