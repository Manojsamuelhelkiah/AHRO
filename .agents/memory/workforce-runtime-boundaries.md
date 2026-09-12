---
name: Workforce runtime boundaries
description: Compatibility, evidence authority, and retry rules for job-context process policies
---

Context corrections and policy replacement must never move a case backward
across an established execution boundary.

**Why:** A legacy case can have completed external work without having task
records in a newer runtime. Missing task state is not evidence that execution
has not happened.

**How to apply:** Preserve historical obligations and refuse unsafe replacement
instead of replaying work. A changed classification alone cannot authorize a
new executor, waive evidence, or reset the execution boundary.