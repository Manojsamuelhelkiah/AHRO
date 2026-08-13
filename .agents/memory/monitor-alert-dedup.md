---
name: Monitor alert dedup must be durable
description: One-alert-per-outage guarantees cannot live in process memory; derive dedup from persisted events.
---

**Rule:** Any "alert once per outage / recover once" guarantee must be derived from durable storage (e.g. the latest persisted monitor event), not in-process counters or flags.

**Why:** Server restarts mid-outage reset in-memory state, producing duplicate outage alerts and losing the recovery event. A completion review rejected an in-memory-only implementation for exactly this.

**How to apply:** Before writing an alert/recovery event, read the latest persisted monitor event and skip the write if it already reflects that state. Also check durable state on the first success after startup so a pending recovery is still recorded. Also: never silently skip failed sub-requests (e.g. per-message detail fetches) inside a "successful" poll — count them and fail the poll, or health stays green while the feature is broken.
