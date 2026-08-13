---
name: Email as a status-change channel
description: Guardrails when inbound email drives workflow state (watch-mailbox tracking)
---

Email is an unauthenticated channel — never let a raw inbound email complete or escalate workflow state.

**Why:** anyone who can reach the mailbox and quote a known reference could forge a "completed" status; a review flagged this as a blocking integrity flaw.

**How to apply:**
- Gate state changes on a trusted-sender allowlist (addresses or domains; unconfigured = trust nobody). Untrusted mail is still recorded on the audit trail, marked "Ignored".
- Inbound email text fed to an LLM is untrusted evidence: fence it with explicit markers, tell the model it can only report recorded state (never confirm/approve), and strictly validate the structured output — malformed output = escalate to a human.
- Ordering for idempotency: apply the (self-guarded, idempotent) state change FIRST, then record the unique provider message id. Recording first can permanently drop a valid email if the apply fails mid-way.
- Guard every completion/escalation on the check's *current* status AND tracking mode (derive expected mode from the source channel) so tracking-mode switches can't be raced by stale polls or already-fetched emails.
- Record the action that actually happened — re-fetch state before writing the audit row, or the trail lies.
