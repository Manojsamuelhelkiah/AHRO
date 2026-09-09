---
name: Wouter query navigation
description: How to preserve and react to query state when navigating with Wouter in this workspace.
---

Treat the current pathname and search string as separate reactive values when reading or replacing URL parameters.

**Why:** Wouter's location hook exposes the base-relative pathname without the query string. Rebuilding a URL from that value alone silently drops scenario identifiers and other context, while pathname-only effects miss Back/Forward changes that alter only the query.

**How to apply:** Subscribe to the search string separately, merge only the parameter being changed, preserve the fragment when relevant, and pass the base-relative pathname plus the merged query to Wouter navigation.