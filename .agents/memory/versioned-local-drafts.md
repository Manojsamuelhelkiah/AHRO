---
name: Versioned local drafts
description: Rules for evolving tenant-scoped browser drafts when accepted identifiers or enum values change.
---

Persist local drafts in an explicit version envelope. Run migrations only after the tenant and user scope has selected the storage key. Convert legacy identifiers only when the mapping is unambiguous; represent unsupported choices as visibly unresolved required fields rather than guessing.

**Why:** Draft upgrades must preserve user work without allowing an old or ambiguous connection choice to silently activate different behavior. Unscoped drafts cannot be safely attributed to a tenant.

**How to apply:** When changing persisted form keys or enum values, increment the draft version, add a deterministic migration from the prior shape, reject unknown future versions, and cover valid legacy plus unresolved legacy payloads in regression tests.

Synthetic demo defaults may be used for a fresh or incomplete draft, but must not replace a migrated draft whose system key or connection mode is unresolved. Those values need to remain visible as required placeholders so the user can repair them instead of silently losing work.

**Why:** An invalid migrated choice is an actionable recovery state, not merely a malformed draft; hiding it behind a complete demo baseline prevents the user from seeing what needs review.

**How to apply:** Preserve unresolved system rows through initial hydration, render disabled “Choose” options, and let schema validation keep navigation blocked until each choice is explicitly repaired.

Unresolved migrated values should carry form-facing review metadata, while canonical server payloads strip that metadata. Clear the marker only after the row has a complete, currently supported replacement.

**Why:** An empty required value blocks unsafe activation but does not explain why the user must repair it; clearing too early would hide an incomplete replacement.

**How to apply:** Keep the marker in the scoped draft and render it next to the affected controls. Treat the marker as UI metadata rather than persisted scenario data, and clear it from the same change handlers that confirm current system and mode compatibility.
