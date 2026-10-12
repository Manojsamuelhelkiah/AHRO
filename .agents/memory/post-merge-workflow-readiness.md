---
name: Post-merge workflow readiness
description: Platform reconciliation success can coexist with failed managed services.
---

Do not infer service readiness from the post-merge runner's or workflow restart's success result alone.

**Why:** In this workspace, reconciliation and workflow restart reported success while managed services failed with occupied ports left by stale preview processes. An old server could still answer health requests, so a successful HTTP response did not prove the updated service had started.

**How to apply:** Confirm affected managed workflows are running after reconciliation. When port conflicts occur, establish process ownership before stopping anything; recover the existing managed service rather than introducing duplicate workflows or changing ports.
