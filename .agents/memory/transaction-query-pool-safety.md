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

Local child writes inside an authority fence must still commit before the
effect journal confirms the outcome. Reuse the fenced connection for parent
reads, but preserve an independent physical-write commit when that is the
existing journal contract.

**Why:** A second SHARE reader waits on the caller's NO KEY UPDATE lock even
though a child foreign-key KEY SHARE would be compatible. Moving the child write
into the outer transaction can instead confirm an effect that later rolls back.

**How to apply:** Check both lock compatibility and commit order when adapting
document/checklist writers. Do not fix a self-wait by dropping the authority
fence or confirming before the physical write commits.
