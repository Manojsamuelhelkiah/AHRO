---
name: Document verification boundaries
description: Safety and decision boundaries for candidate documents and background-verification results.
---

Local checksum, structure, declared-type, and basic active-content checks must never be presented as source authenticity, identity, expiry, tamper, or malware proof. Without the relevant provider, those outcomes remain explicitly unavailable or pending human review. Rejected, uncertain, and adverse provider results are evidence for a human decision, not an automated employment decision.

**Why:** Deterministic file inspection can establish integrity and obvious format problems, but it cannot prove that an issuing authority created the document or that an employment action is appropriate.

**How to apply:** Keep provider contracts normalized and provider-neutral, preserve evidence without exposing private provider payloads, route uncertainty and adverse results to authorized HR reviewers, and let only configured mandatory requirements block readiness.