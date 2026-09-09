---
name: Approval handoff durability
description: Durable rules for handing asynchronous human decisions back to fenced orchestration.
---

Approval creation, the transition to a waiting state, decision persistence, and continuation claiming must converge through one durable reconciliation path. That reconciler must tolerate decisions arriving before the waiter is visible, process interruption after a decision, and concurrent retries.

**Why:** A fire-and-forget continuation can lose its wakeup when the decision commits before the engine records its waiting state, or when the process stops after the decision but before claiming continuation. Separating prerequisite repair from the continuation claim also creates crash windows.

**How to apply:** Persist an explicit waiting boundary, reconcile both immediately and from the periodic recovery path, atomically commit prerequisite state with the fenced continuation claim, and provide a conservative compatibility derivation for legacy waiting rows that predate explicit checkpoints.