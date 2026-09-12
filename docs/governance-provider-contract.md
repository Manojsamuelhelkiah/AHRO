# Governance provider-boundary contract

Task 251 keeps the governance decision register separate from provider
implementations. A provider adapter must call
`evaluateProviderGovernanceGate` with one of these server-owned scopes:

- `candidate-communications` — candidate email and WhatsApp delivery,
  including retries and administrative case notices;
- `candidate-voice` — Twilio Voice lookup and call creation;
- `candidate-portal` — candidate-link/token issuance and delivery;
- `worker-record-documents` — an authoritative document provider receiving a
  candidate file (this is the existing canonical document-processing scope).

`governance-runtime` owns the canonical `GovernanceWorkflow` union and
decision/requirement mapping. It must recognize all four scopes. At minimum,
privacy/legal/safety decisions which govern candidate data or contact must
map to the relevant scope; a provider adapter must never parse mutable
decision titles, request fields, or a historical case snapshot to choose a
scope.

## Required order at a real boundary

1. Read the stored, tenant-scoped case and evaluate current governance before
   its per-effect claim (inside an existing case fence when that path has one).
2. If denied, persist only the existing local blocked/logged-only outcome (or
   leave document validation in manual review); do not claim or invoke the
   provider.
3. Preserve the existing durable effect/outbound-journal claim for permitted
   work.
4. Commit the organization governance-dispatch marker, then re-evaluate as the
   first callback operation immediately before each mutating provider request.
   A revoked decision, authority, requirement activation, or provider policy
   must prevent that request. The runtime evaluator must not run in
   `withGovernanceDispatch.beforeDispatch`: it can use the global DB handle to
   seed/read governance and would self-deadlock on the organization advisory
   lock. Once the marker exists, concurrent governance mutation is instead
   fail-closed by the shared fence.

The durable dispatch fence serializes governance mutations with the final
check; it is not a permission grant. An unresolved/ambiguous provider attempt
remains an existing manual-reconciliation state and cannot be converted to a
simulation or retried as a new live effect.

`isolated-simulation` is derived only from server-stored case classification.
It can record explicitly labelled local simulation, but source-mode simulated
evidence never satisfies a live requirement and `runWithProviderDeny` remains
monotonic. Explicit Demo Controller volunteer authorization and ordinary
authenticated candidate-email authorization remain separate, narrow gates;
neither bypasses governance.

Document-storage and authoritative-document-provider adapters never opt in to
isolated provider dispatch. Only the existing, separately authorized
Demo Controller communication/voice path may pass
`allowIsolatedProviderDispatch: true`, and it must still satisfy its scoped
volunteer revalidation immediately before I/O.