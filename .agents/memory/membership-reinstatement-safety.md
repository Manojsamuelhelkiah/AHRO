---
name: Membership reinstatement safety
description: Removal lifecycle versions and narrowly scoped audit rationale.
---

Use a persistent increasing version to distinguish removal cycles; a timestamp alone is not a safe reinstatement precondition.

**Why:** Reinstatement clears a tombstone timestamp, and a subsequent removal can repeat that timestamp under clock rollback or millisecond collisions. An old owner decision must not authorize a new removal cycle.

**How to apply:** Compare the reviewed lifecycle version atomically and advance it across removal and reinstatement. Test identical timestamps across different removal cycles.

Retain required owner rationale only for the intended audit action, rather than globally allowing generic free-text reasons.

**Why:** Broadening an audit metadata allowlist can silently retain sensitive text from unrelated callers; audit reviewers may have broader access than the owner-only action.

**How to apply:** Keep action-specific retention bounded, warn owners against sensitive details, and test that unrelated reasons are still stripped.