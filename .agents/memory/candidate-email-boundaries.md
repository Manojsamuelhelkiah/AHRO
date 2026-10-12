---
name: Default candidate email boundaries
description: Current address enables candidate email, not other channels or effects; sample exceptions and safe retries remain narrowly scoped.
---

Use the current case's valid deliverable candidate address for normal email eligibility, regardless of intake source, age, Email/Both/WhatsApp preference or legacy authorization timestamp. Reserved placeholder domains are not deliverable. Preserve legacy authorization fields only as audit history.

**Why:** On 2026-10-12 the user explicitly revised the prior Email/Both and manual-intake-only rule: a provided deliverable address is sufficient, including existing, imported and demo/sample cases. This does not grant unrelated recipient permissions, waive privacy or governance, or activate non-email workflows.

**How to apply:** Keep administrative and WhatsApp permissions independent. Email is the required default; preference selects additional WhatsApp and inbound reply routing. Candidate email on an offline sample needs normal live privacy/governance approval and dispatch/reset protection, not simulated approval. Keep run-owned UAT provider denial absolute, even when its mutable scenario metadata resembles a sample. A narrow sample-email exception must be consistent across the dispatch guard, journal and final provider boundary; never relax the generic offline classifier. An emailed portal credential needs its own current full authority and privacy checks. Preserve sequencing: request the offer package first; ordinary welcome/onboarding still waits for human acceptance. Rollout must not start cases or resend historical messages.

Retry only messages known not to have been sent. A provider timeout or interrupted request can mean Gmail accepted the email even when the application did not receive confirmation.

**Why:** Delivering a duplicate welcome or sensitive request is worse than requiring review of an uncertain outcome. A successful provider response establishes acceptance, not inbox delivery.

**How to apply:** Preserve an uncertain, non-retryable state until reconciled. Retry definite failures or blocked messages using the stored content, current case recipient, send limits, and an atomic database claim. Browser tests must intercept delivery requests; automated backend tests must use a fake provider.

An eligibility change must not dispatch a saved communication merely because it has no journal yet. Precomposing a new payload needs proof that it was created in the current invocation; a saved `sending` status alone is not that proof.

**Why:** Payload precomposition can precede journal creation, but historical denials and interrupted operations can also lack a journal. Treating either as a new send creates a rollout backlog or duplicates.

**How to apply:** Keep a fresh, server-owned preparation receipt separate from persisted state. Replays return recorded outcomes; journal uncertainty and manual-retry gates still apply.