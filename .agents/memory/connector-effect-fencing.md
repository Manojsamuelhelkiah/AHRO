---
name: Connector effect fencing
description: Safety boundary required for payroll, access, and other remote connector writes.
---

Every future outbound connector write must pass through the durable effect journal, and providers that support idempotency must receive the journal's unchanged logical operation key.

Expired in-flight work may be reclaimed only when the provider guarantees idempotency. An expired non-idempotent dispatch is an unknown external effect and must stop for reconciliation or manual repair rather than being sent again.

**Why:** A process can crash after a provider accepts a write but before local confirmation. Database fencing prevents stale local commits, but only provider idempotency or stopping for reconciliation prevents a duplicate remote payroll/access change.

**How to apply:** Integrate the journal at the outbound provider-call boundary. Keep the logical operation key stable across plan versions, bind it to the case and canonical arguments, and condition every claim and completion on the current fencing token and owner.

An HTTP error response is not proof that a remote write did not happen. Treat uncertain server errors and successful responses without a usable receipt as ambiguous unless the approved vendor contract establishes otherwise.

**Why:** A provider can commit a request and then fail while assembling its response. Labeling that failure “before write” defeats the journal's non-idempotent recovery protection.

**How to apply:** Reserve retryable pre-write rejection for provable pre-dispatch denials. Keep unknown outcomes in reconciliation, and test post-acceptance errors as well as network timeouts.

Release eligibility and edits that can revoke it must share the case-dispatch fence. A preliminary status read is only a user-facing explanation, not execution authorization.

**Why:** A new exception hold or joining-date reconciliation can invalidate eligibility between an early check and the remote effect. Protecting only the writer leaves revoking edits free to race it.

**How to apply:** Recheck current holds inside the final dispatch transaction. Make date, hold, and reconciliation mutations acquire the matching mutation lock and reject active or unresolved dispatch markers.