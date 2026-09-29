---
name: Access preview consistency
description: Keep owner-facing access discovery aligned with live authorization decisions.
---

Access previews and “who can access this field” reports must call the same effective-access evaluator used at enforcement boundaries. Include the requested case scope and an explicit initiating human for an agent; do not infer the agent owner as initiator.

**Why:** A duplicate Settings evaluator incorrectly counted pending non-sensitive attachments, missed named allows and denies, and omitted case-scoped grants. It could tell an owner the opposite of what the API enforces.

**How to apply:** When extending policy vocabulary or grant sources, update the shared evaluator, not a separate reporting shortcut. Test pending grants, named denies, case-specific grants, and agent/initiator intersections on both decision and discovery endpoints.