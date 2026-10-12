---
name: Post-merge workflow readiness
description: Platform reconciliation success can coexist with failed managed services.
---

Do not infer service readiness from the post-merge runner's success result alone.

**Why:** In this workspace, reconciliation reported success while managed frontend workflows failed with occupied ports left by stale preview processes. The database checks had passed, but the services had not restarted.

**How to apply:** Confirm affected managed workflows are running after reconciliation. When port conflicts occur, establish process ownership before stopping anything; recover the existing managed service rather than introducing duplicate workflows or changing ports.
