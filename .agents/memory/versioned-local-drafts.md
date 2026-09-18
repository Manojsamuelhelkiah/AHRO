---
name: Versioned local drafts
description: Rules for evolving tenant-scoped browser drafts when accepted identifiers or enum values change.
---

Persist local drafts in an explicit version envelope. Run migrations only after the tenant and user scope has selected the storage key. Convert legacy identifiers only when the mapping is unambiguous; represent unsupported choices as visibly unresolved required fields rather than guessing.

**Why:** Draft upgrades must preserve user work without allowing an old or ambiguous connection choice to silently activate different behavior. Unscoped drafts cannot be safely attributed to a tenant.

**How to apply:** When changing persisted form keys or enum values, increment the draft version, add a deterministic migration from the prior shape, reject unknown future versions, and cover valid legacy plus unresolved legacy payloads in regression tests.