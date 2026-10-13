---
name: Email as a status-change channel
description: Guardrails when inbound email drives workflow state (watch-mailbox tracking)
---

The user states that the original product design emails every Action Center event or case to its action owner and lets that owner perform the action by email.

**Why:** Email is intended to be an operational action channel, not merely a candidate intake channel or a notification linking back to the app.

**How to apply:** Assess owner notification and reply-to-action coverage separately for each Action Center item type. Do not claim that candidate-email defaults, case intake or approval-specific handling provide universal coverage. Preserve verified owner identity, current authority, exact tenant/item/version correlation and duplicate/stale-reply protection when extending email actions.

The user confirmed an agentic, multichannel operating model: some HR users should handle transactions entirely through email or chat without logging into the app.

**Why:** Smooth conversational execution is a product requirement; the app is an optional control tower, not the mandatory transaction interface.

**How to apply:** Support verified enrolment and authority binding without requiring routine app sign-in, then maintain one case/task state across channels. Let the agent explain requests, interpret responses, ask for clarification when needed and confirm actual recorded outcomes. Channel identity is not professional authority, and conversational acknowledgement is not evidence that external work happened. Confirm the first chat provider rather than assuming one.

Email is an unauthenticated channel — never let a raw inbound email complete or escalate workflow state.

**Why:** anyone who can reach the mailbox and quote a known reference could forge a "completed" status; a review flagged this as a blocking integrity flaw.

**How to apply:**
- Gate state changes on a trusted-sender allowlist (addresses or domains; unconfigured = trust nobody). Untrusted mail is still recorded on the audit trail, marked "Ignored".
- Inbound email text fed to an LLM is untrusted evidence: fence it with explicit markers, tell the model it can only report recorded state (never confirm/approve), and strictly validate the structured output — malformed output = escalate to a human.
- Ordering for idempotency: apply the (self-guarded, idempotent) state change FIRST, then record the unique provider message id. Recording first can permanently drop a valid email if the apply fails mid-way.
- Guard every completion/escalation on the check's *current* status AND tracking mode (derive expected mode from the source channel) so tracking-mode switches can't be raced by stale polls or already-fetched emails.
- Record the action that actually happened — re-fetch state before writing the audit row, or the trail lies.
