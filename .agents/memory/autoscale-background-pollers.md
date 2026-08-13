---
name: Autoscale pauses in-process pollers
description: Production heartbeat pattern for setInterval-based background work on autoscale deployments
---

Autoscale deployments only execute while an HTTP request is in flight, so any `setInterval` poller silently pauses when traffic stops — health checks, SLA sweeps, and outage alerts stop off-hours.

**Why:** prod's `onb_system_checks` stayed empty despite a synced schema; the watchers only ticked while someone had the app open.

**How to apply:** every background poller must expose a run-once function (guarded against overlap, never throws) and an unauthenticated, idempotent, throttled heartbeat endpoint must drive all of them (`/api/onboarding/webhooks/watcher-tick`, throttled to 1 tick/5s). Production needs an external scheduler hitting it every 1–5 min (`scripts/watcher-heartbeat.mjs`) or a Reserved VM republish. When adding a new poller, wire it into this tick endpoint too — on autoscale, also make sure the tick work is awaited before the HTTP response is sent, or it may be frozen mid-flight.
