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

Self-starting smoke-test dependencies must use fallback ports separate from the managed preview services.

**Why:** During parallel workflow startup, a smoke test can see a temporarily unavailable API and launch its own validation-mode API on the preview port. The managed API then fails with an address-in-use error; the smoke test's normal cleanup removes the temporary API and leaves no service running.

**How to apply:** Reuse a healthy managed service when available, but start missing test dependencies on isolated ports. Cleanup must stop only test-owned processes; never change preview ports or weaken authentication to make a smoke check pass.
