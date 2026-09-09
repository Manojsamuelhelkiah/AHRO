---
name: Versioned policy snapshot replacement
description: Concurrency and gate-safety rules for changing versioned policy snapshots on active transactions.
---

All writes that can affect one effective versioned policy must share one organization-scoped transactional lock. Replacing a policy snapshot on a transaction must also lock that transaction, compare the caller's expected snapshot revision, and reject replacement while an execution claim is active.

Never introduce an unmet mandatory gate behind a boundary that already produced effects. Reject the replacement before intermediate boundaries; after the final boundary, move the transaction to an explicit re-review state without replaying earlier effects.

**Why:** Independent validation locks can let two individually valid policy writes commit an invalid combination. A read-before-transaction replacement can race orchestration, mutate the rules under a running worker, duplicate an audit transition on retry, or add a gate after its protected effect already happened.

**How to apply:** Use this rule whenever organization configuration is versioned and snapshotted onto a durable workflow. Resolve the effective policy under the policy lock, persist provenance with the snapshot, and make replacement an optimistic, audited transition at a known checkpoint.