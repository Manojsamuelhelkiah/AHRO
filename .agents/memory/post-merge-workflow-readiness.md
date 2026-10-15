---
name: Post-merge workflow readiness
description: Platform reconciliation success can coexist with failed managed services.
---

Do not infer service readiness from the post-merge runner's or workflow restart's success result alone.

**Why:** In this workspace, reconciliation and workflow restart reported success while managed services failed with occupied ports left by stale preview processes. An old server could still answer health requests, so a successful HTTP response did not prove the updated service had started.

**How to apply:** Confirm affected managed workflows are running after reconciliation. When port conflicts occur, establish process ownership before stopping anything; recover the existing managed service rather than introducing duplicate workflows or changing ports.

API build outputs are shared by workflows, not exclusively owned by the API service's startup command.

**Why:** An API startup failed with an unexpected end of input in generated JavaScript even though a subsequent syntax check of the same output passed. A competing build can replace output while another workflow starts Node; a successful compilation alone is not proof the process read a complete artifact.

**How to apply:** Preserve the last complete output during builds and publish complete files atomically, with the server entry published last. Verify the actual managed process and health response after recovery rather than relying on the bundle currently on disk.
