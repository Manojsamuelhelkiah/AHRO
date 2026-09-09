---
name: Pre-trust startup alerts
description: How to durably deduplicate operator notifications emitted before tenant safeguards have passed.
---

**Rule:** A production-startup alert that reports failed tenant validation must
claim its delivery in durable state independent of the application database. A
successful validation clears the active claim so a later outage can alert again.

**Why:** Database rows cannot be used when a failed or stalled database
connection is itself what blocked startup. Tenant-owned rows also cannot be
trusted when missing tenant parents, foreign keys, or tenant columns caused the
block. Process memory resets on each deployment retry.

**How to apply:** Atomically create an App Storage marker before dispatch.
Suppress retries while it exists, delete it after a definite provider rejection
or successful verification, retain it after an ambiguous dispatch, and never
include safeguard findings or database details in the operator message. Put a
short overall deadline around both notification and marker reset: alert delays
must not postpone the original startup failure, and reset delays must never
block a verified release from serving. A deadline only stops awaiting work; the
failed-startup CLI must explicitly exit nonzero afterward so SDK sockets or
retry timers cannot keep an unsafe release alive.