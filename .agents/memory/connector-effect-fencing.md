---
name: Connector effect fencing
description: Safety boundary required for payroll, access, and other remote connector writes.
---

Every future outbound connector write must pass through the durable effect journal, and providers that support idempotency must receive the journal's unchanged logical operation key.

Expired in-flight work may be reclaimed only when the provider guarantees idempotency. An expired non-idempotent dispatch is an unknown external effect and must stop for reconciliation or manual repair rather than being sent again.

**Why:** A process can crash after a provider accepts a write but before local confirmation. Database fencing prevents stale local commits, but only provider idempotency or stopping for reconciliation prevents a duplicate remote payroll/access change.

**How to apply:** Integrate the journal at the outbound provider-call boundary. Keep the logical operation key stable across plan versions, bind it to the case and canonical arguments, and condition every claim and completion on the current fencing token and owner.