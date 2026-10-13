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

Marker replacement is a permanent retirement, not a temporary pause. A replacement binding requires a different verified reviewer from the person staging it, on the same verified Gmail primary mailbox. Held-request re-admission never restores sender trust, previous field-review authority, or operational release.

**Why:** The requested recovery workflow must preserve held requests without reopening a compromised marker or turning an old review into permission under a new binding.

**How to apply:** Preserve original message/mailbox/route provenance and private-source/retention holds. Select pre-retirement, same-client held requests explicitly with request and route version fences; leave unselected and post-retirement mail fenced.

Do not retire a replacement while its predecessor still has unreconciled held requests, unless a separately reviewed chain-aware recovery path exists.

**Why:** A selected-only migration otherwise strands the requests left behind when their only approved replacement is later retired.

**How to apply:** Require earlier requests to be re-admitted or rejected before a subsequent rotation; do not silently transfer the remaining backlog.