---
name: Monitor alert dedup must be durable
description: One-alert-per-outage guarantees cannot live in process memory; derive dedup from persisted events.
---

**Rule:** Any "alert once per outage / recover once" guarantee must be derived from durable storage, not in-process counters or flags. Multi-recipient alerts need recipient-scoped acknowledgements and separate episode histories.

**Why:** Restarts reset in-memory state, one recipient can fail while another succeeds, and flapping can begin a new outage before every recovery from the prior outage is delivered. One global flag loses or suppresses notifications.

**How to apply:** Atomically claim each recipient send, acknowledge it only after delivery, and retry only outstanding recipients. Keep active outages separate from older pending recoveries. Once an episode recovers, fence new outage claims but let existing claims finish; before deleting it, atomically recheck current claims and owed recoveries rather than trusting an earlier recipient snapshot. Also: never silently skip failed sub-requests (e.g. per-message detail fetches) inside a "successful" poll — count them and fail the poll, or health stays green while the feature is broken.
