---
name: Administrator session observation
description: Explicit live server state governs administrator UI; missing metadata and responses from previous sessions are not revocations.
---

Do not infer administrator expiry from a missing privilege header on an
unrelated response. Only an explicit negative result from the current session,
or its confirmed lifetime ending, may remove verified access.

**Why:** Protected screens share a request observer with ordinary reads. Some
responses legitimately omit privilege metadata; interpreting absence as an
expiry can cause navigation-dependent failures even though the server grant
remains valid. A delayed denial from an older session can similarly arrive
after renewal and incorrectly tear down newly verified access.

**How to apply:** Fence unsuccessful responses and asynchronous response-body
processing against session transitions, not only successful protected data.
Readiness authorization must run before mailbox availability lookup so a
restricted account receives an access explanation rather than a provider error.
Keep queue/source/review/configuration/conversion permissions independent.
