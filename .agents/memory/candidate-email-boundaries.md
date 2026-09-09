---
name: Candidate email authorization boundaries
description: Why manual onboarding intake authorizes case-scoped candidate email rather than broad recipient permissions, and how retries must treat uncertainty.
---

Treat authenticated manual intake with Email/Both selected as authorization to contact the candidate on that case, not as permission to add the address to a global allowlist. Do not extend this implicit permission to seeded/scenario cases, administrative approvals, channel tests, or WhatsApp.

**Why:** The approved product behavior is that HR entering a real candidate should enable candidate communications without a separate demo-volunteer step. Reusing global permissions would unintentionally grant unrelated administrative or WhatsApp access. Existing explicitly authorized demo recipients must continue working.

**How to apply:** Resolve candidate recipients from the current case record; preserve the independent administrative and WhatsApp permission checks when adding new sending paths. Real case intake with Email/Both should automatically provision and deliver the candidate portal link; seeded/scenario and unauthorized cases must not. Treat future contact-edit features as authorization-sensitive work, not just text editing.

Retry only messages known not to have been sent. A provider timeout or interrupted request can mean Gmail accepted the email even when the application did not receive confirmation.

**Why:** Delivering a duplicate welcome or sensitive request is worse than requiring review of an uncertain outcome. A successful provider response establishes acceptance, not inbox delivery.

**How to apply:** Preserve an uncertain, non-retryable state until reconciled. Retry definite failures or blocked messages using the stored content, current case recipient, send limits, and an atomic database claim. Browser tests must intercept delivery requests; automated backend tests must use a fake provider.