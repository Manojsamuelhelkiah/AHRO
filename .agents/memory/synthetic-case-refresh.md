---
name: Synthetic case refresh safety
description: Consent, provenance, offline authority, and storage boundaries for replacing demo cases.
---

Refreshing synthetic cases does not activate workflows or authorize external business changes. Their persistent offline marker remains authoritative for non-email operations. A supplied deliverable candidate address permits normal requested email under the separate [candidate email boundaries](candidate-email-boundaries.md), never non-email activation or isolated UAT delivery.

**Why:** Synthetic-looking names, scenario keys and demo membership do not establish professional authority or evidence. The user explicitly revised the blanket email denial on 2026-10-12, but retained privacy/governance review, reset locking and all non-email fences.

**How to apply:** Confirm an explicit, tenant-scoped inventory against source provenance; preserve ambiguous and manually entered cases. Do not broaden a reset to every row with a scenario key or every row in a demo workspace.

Case deletion must serialize with external dispatch, not merely check for activity beforehand. Retain external-effect evidence and stop on unresolved effects.

**Why:** A worker may have read a case or queued message before the reset begins. A later deletion cannot undo delivery, and an unlocked activity snapshot cannot prevent a cached worker from dispatching after deletion.

**How to apply:** Commit a durable in-flight dispatch record under a short parent-case lock before provider work begins. Reset must lock that same parent and refuse active or unknown records. Release the database connection before provider callbacks; nested callbacks use the existing dispatch context. Callback failure or process death must preserve uncertainty, never allow automatic reclaim. Test the actual dispatch-versus-delete race, not just static blocked states.

Do not hold a transaction across provider callbacks that perform their own database work, or roll the provider's durable journal into that surrounding transaction.

**Why:** Concurrent outer transactions can exhaust the connection pool while their callbacks wait for another connection. Rolling back an outer transaction after an external side effect can also erase the evidence needed for recovery.

**How to apply:** Keep dispatch acquisition and finalization short and separately committed; exercise nested callbacks and concurrency beyond the database pool size.

Reset confirmation revisions must fingerprint meaningful data, not incidental refresh timestamps.

**Why:** Background reconciliation can update a case timestamp without changing its business state, producing false stale-reset failures while an owner confirms the inventory.

**How to apply:** Canonically sort and hash the actual case/evidence/contact/approval/dispatch state. Test that timestamp-only refreshes remain valid while meaningful edits invalidate confirmation.

Deleting case records must not automatically destroy uploaded bytes shared with another environment. Retain private file descriptors for explicit later cleanup rather than leaving untracked objects or exposing paths in reset responses.

**Why:** Development and production records can refer to the same storage object even though their databases are separate. A development cleanup must not remove a file still referenced by production.

**How to apply:** Preserve tenant attribution and storage references transactionally when removing case-linked upload rows; treat physical object deletion as a separate operation requiring cross-environment reference checks.