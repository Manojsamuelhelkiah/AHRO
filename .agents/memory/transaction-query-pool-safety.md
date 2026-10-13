---
name: Transaction query pool safety
description: Prevent pooled-query starvation while serializing tenant administration.
---

Authorization and eligibility reads inside a tenant-locked transaction must
reuse its connection, including helper lookups of globally registered identities.

**Why:** Concurrent transactions waiting for the same advisory lock can occupy
every pooled connection. If the lock winner calls a helper that queries the
global pool, it waits for a connection that none of the blocked contenders can
release. Small concurrency tests can miss this failure.

**How to apply:** Pass the transaction to nested read helpers, or perform their
equivalent authoritative reads on that transaction. Exercise concurrency above
the pool size. Do not solve starvation by weakening the lock or trusting stale
authorization snapshots.
