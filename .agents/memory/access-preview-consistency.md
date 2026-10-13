---
name: Access preview consistency
description: Keep owner-facing access discovery aligned with live authorization decisions.
---

Access previews and “who can access this field” reports must call the same effective-access evaluator used at enforcement boundaries. Include the requested case scope and an explicit initiating human for an agent; do not infer the agent owner as initiator.

**Why:** A duplicate Settings evaluator incorrectly counted pending non-sensitive attachments, missed named allows and denies, and omitted case-scoped grants. It could tell an owner the opposite of what the API enforces.

**How to apply:** When extending policy vocabulary or grant sources, update the shared evaluator, not a separate reporting shortcut. Test pending grants, named denies, case-specific grants, and agent/initiator intersections on both decision and discovery endpoints.

Bulk reads may share current database inputs within a single request, but must
run the same permission and independent-authority rules as individual reads.
Never persist or reuse that request's permission result for another request.

**Why:** Retained fictional inventory needs efficient reads without turning
offline visibility into authority or allowing revoked membership and revised
policies to survive in a permission cache.

**How to apply:** Compare bulk output against individual projections, including
explicit denies, owner revocations, sensitive redaction and agent intersections.
Offline-only screens still need periodic permission refresh and must hide
cached metadata after a failed refresh.