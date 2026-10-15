---
name: HRO case cleanup boundaries
description: Authorized one-time cleanup scope and distinction between display references and fictional examples.
---

The user authorized permanent deletion of HRO-prefixed cases in Demo Organization in the main development preview only. This is distinct from the earlier task-preview curation authorization; neither permits cleanup in the published app or other clients.

**Why:** The user explicitly clarified cases rather than apps and selected the main development preview and Demo Organization. HRO display references are not proof of fictional data.

**How to apply:** Resolve the authoritative display projection before deletion, preserve S-prefixed examples, independent Vault ownership and required audit/provider evidence, and report blocked records honestly. Do not replay one-time cleanup or broaden it to other environments.

Use the app's actual display predicates, not a SQL approximation of provenance, address shape or notes, to classify the deletion inventory.

**Why:** A database-only estimate misclassified preserved fictional examples as HRO references. The reference prefix is computed from several server-owned facts.

**How to apply:** Inventory using the same profile-readable projection as the authorized app view. Freeze exact IDs and a review revision; reruns must use the completed receipt rather than selecting newly created cases.

Deleting a case-owned intake source must leave an enforceable source tombstone, not merely a historical deletion note.

**Why:** Removing a restrictive source foreign key can otherwise permit an old request to create the same case again on retry.

**How to apply:** Persist source identity tombstones atomically with deletion and check them inside the intake transaction. Retain required historical evidence privately without restoring operational case records.
