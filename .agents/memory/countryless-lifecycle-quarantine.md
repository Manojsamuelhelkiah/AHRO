---
name: Countryless lifecycle quarantine
description: How background workers handle legacy cases whose work jurisdiction cannot be proven.
---

Missing work jurisdiction must keep sensitive collection fail-closed, but background workers should treat that expected boundary as a durable case quarantine rather than a cycle-level failure.

**Why:** Re-throwing the same expected policy conflict on every heartbeat creates noisy failures and can hide actionable worker outages. The ordinary collection gate cannot record its own block because the marker write would be rejected by the same gate.

**How to apply:** Before readiness work, detect an unprovable jurisdiction and persist one idempotent marker containing only fixed, non-sensitive remediation text. Do not infer a country or enroll/process the case. Repaired cases should resume normal fresh policy evaluation.