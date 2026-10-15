---
name: Snapshot-backed form review
description: Reconcile authoritative saved details without silently replacing user intent or unresolved registration requests.
---

Authoritative snapshot refreshes may update displayed saved details, but must not silently discard an explicit replacement choice. Changed relevant evidence invalidates the prior review and replacement acknowledgement. A missing chosen record is a visible unavailable selection, not permission to choose an arbitrary fallback.

**Why:** Existing-principal registration must let administrators distinguish the current binding from the exact candidate they reviewed, including changes by other administrators.

**How to apply:** Separate initial role-bound selection from intentional choices. Reset selection on explicit role navigation, keep new-principal drafts separate from existing saved information, and reconcile refreshes within the current tenant/session scope.

An unknown submission outcome locks its exact original payload and request ID. Refreshing saved information is not cancellation or permission to create a new request. Tenant/session transitions still discard private form state.

**Why:** A response can be lost after the server commits; rebuilding a submission from newer data defeats safe identical-request retries.

**How to apply:** Treat unresolved requests separately from current-snapshot presentation. Keep the retry invariant across ordinary refetches and transient read failures, without carrying it into a different authenticated scope.

Failed private reads must remove the private DOM subtree, not merely hide it.
Only the exact unresolved retry request may survive a transient read failure
outside that subtree. Authorization denial clears both that request and the
previous administrative query snapshot.

**Why:** HTML-hidden content is still readable in the DOM after access ends.

**How to apply:** Keep retry recovery separate from private display state.
Preserve neither saved identity details nor new-principal drafts across denied
reads, and ensure scope transitions also destroy any retained request.
