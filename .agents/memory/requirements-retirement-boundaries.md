---
name: Requirements Register retirement
description: Product scope and historical-data boundaries for the retired manual coverage register
---

The Requirements Register is permanently retired, not relocated to UAT or
renamed as another coverage-management screen. Historical coverage assertions
are neither permission nor a prerequisite for future work.

**Why:** The user explicitly superseded the proposed relocation and requested
retirement of manual implementation, testing, configuration and live-approval
management, while preserving real operational protections and historical data.

**How to apply:** Keep objective trusted-provider and source-evidence protections
independent of historical register rows. Do not bulk approve legacy coverage,
resume held cases or replay effects as part of retirement. Preserve policy
reviews, explicit case approvals, operational readiness, source-document
requirement traceability, and immutable audit history.

The product owner also permanently removed the legacy “Privacy/jurisdiction and retention defaults” and “Live activation and specialist authority” requirements. They must not remain active approval gates or be reintroduced as a separate Demo Ask AI approval.

**Why:** The user explicitly requested removal after these inherited provisional requirements blocked read-only Ask AI, rather than accepting a new parallel approval process.

**How to apply:** Exclude the retired requirements from active policy lists, future seeding, reminders and runtime evaluation, including historical snapshots. Preserve historical audit records and independent authentication, tenant permissions, provider-deny, disclosure, UAT/controller isolation and objective source-evidence protections.
