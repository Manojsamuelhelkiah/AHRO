---
name: BGV notification boundaries
description: Human coordination versus simulated operational notices, sensitive findings, and source provenance.
---

BGV human coordination notices may use configured live email, but provider requests and IT/payroll/facilities hold/release notices remain operational simulations. Internal vendor simulations must never become trusted-provider evidence for live notification dispatch, even outside Demo Organization.

**Why:** The user explicitly distinguishes genuine communication between people from the operational interfaces that have not been implemented. Existing simulated watcher and mailbox paths can otherwise look like real vendor events.

**How to apply:** Preserve provenance through every transition. Required recipients and delivery authorization are separate: show an actionable candidate notice as blocked when authorization is missing, rather than hiding the stakeholder. Keep raw findings out of notification payloads; direct authorized reviewers to private review. A delay is not an adverse finding, and release coordination is not employment clearance.

Recipient changes, a clear/release, and dispatch must share a serialization boundary; checking current state before an unrelated effect claim does not fence a stale email.

**Why:** Per-message idempotency prevents duplicate sends of the same message but does not prevent sending an obsolete block message after a newer release or recipient revocation.

**How to apply:** Revalidate current source state, episode, recipient authorization, and configuration at dispatch admission. Do not automatically retry a provider outcome that is uncertain.

Keep session-lock connections separate from the pool used by work performed inside the lock.

**Why:** Concurrent cases can consume every shared-pool connection while holding locks, then deadlock waiting for additional connections to perform the protected work. Bounded lock acquisition alone does not prevent this.

**How to apply:** Use separately bounded lock connections, release local queues even when acquisition fails, and bound provider attempts; a timeout remains an uncertain outcome rather than permission to resend.

Demo simulation restrictions and paused-offline read-only restrictions are separate states.

**Why:** Treating every Demo case as offline disabled all of the member-accessible simulation controls even though the API reported permission to manage them.

**How to apply:** Demo members may configure and run simulations; only genuinely paused offline cases are read-only. Enforce no-live-send rules independently on the server.