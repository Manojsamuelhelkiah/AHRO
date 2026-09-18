---
name: Versioned local drafts
description: Rules for evolving tenant-scoped browser drafts when accepted identifiers or enum values change.
---

Persist local drafts in an explicit version envelope. Run migrations only after the tenant and user scope has selected the storage key. Convert legacy identifiers only when the mapping is unambiguous; represent unsupported choices as visibly unresolved required fields rather than guessing.

**Why:** Draft upgrades must preserve user work without allowing an old or ambiguous connection choice to silently activate different behavior. Unscoped drafts cannot be safely attributed to a tenant.

**How to apply:** When changing persisted form keys or enum values, increment the draft version, add a deterministic migration from the prior shape, reject unknown future versions, and cover valid legacy plus unresolved legacy payloads in regression tests.

Unresolved migrated values should carry form-facing review metadata, while canonical server payloads strip that metadata. Clear the marker only after the row has a complete, currently supported replacement.

**Why:** An empty required value blocks unsafe activation but does not explain why the user must repair it; clearing too early would hide an incomplete replacement.

**How to apply:** Keep the marker in the scoped draft and render it next to the affected controls. Treat the marker as UI metadata rather than persisted scenario data, and clear it from the same change handlers that confirm current system and mode compatibility.