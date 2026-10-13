---
name: Shared mailbox tenant attribution
description: Rules for safely routing inbound email when multiple client organizations share provider inboxes.
---

Never infer a client organization from sender identity alone. Candidate replies need an exact, randomly generated case-bound reference tied to a prior outbound message; operational check references must be parsed as complete tokens and resolved globally before choosing a tenant.

**Why:** The same email address can legitimately or adversarially appear in multiple organizations, and prefix matching can route one tenant's message into another tenant's timeline or workflow.

**How to apply:** Generate the reference with cryptographic randomness in the first durable outbound payload and reuse that stored payload on retries; never derive it from a sequential ID or predictable idempotency key. Resolve ownership before tenant-scoped mutation, exclude messages owned by another consumer such as approvals, deduplicate across consumers, and quarantine missing, fabricated, ambiguous, duplicate, or prefix-only matches.

New-request route markers express reviewed mailbox-to-client routing only. They never establish sender identity, verified employment, offer acceptance, specialist authority or approved evidence. Unbound requests must not borrow an arbitrary client's collection approval.

**Why:** Universal intake shares the mailbox with existing reply, approval and status consumers. Receiving or reviewing a request is not permission to execute its requested operation, especially for families with only specialist-review templates.

**How to apply:** Keep routing, confidential collection, family admission and operational release as distinct checks. A missing jurisdiction requires explicit correction under approved collection policy, not a guessed onboarding date or default client. Resume or reverify routing without silently replaying a paused historical inbox.