---
name: Shared mailbox tenant attribution
description: Rules for safely routing inbound email when multiple client organizations share provider inboxes.
---

Never infer a client organization from sender identity alone. Candidate replies need an exact, unguessable case-bound reference tied to a prior outbound message; operational check references must be parsed as complete tokens and resolved globally before choosing a tenant.

**Why:** The same email address can legitimately or adversarially appear in multiple organizations, and prefix matching can route one tenant's message into another tenant's timeline or workflow.

**How to apply:** Resolve ownership before tenant-scoped mutation, exclude messages owned by another consumer such as approvals, deduplicate across consumers, and quarantine missing, ambiguous, duplicate, or prefix-only matches.