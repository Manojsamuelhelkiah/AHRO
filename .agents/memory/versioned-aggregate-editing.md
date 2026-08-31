---
name: Versioned aggregate editing
description: Concurrency rule for mutable JSON aggregates and destructive lifecycle operations.
---

Mutable JSON aggregates must combine server-side optimistic version checks with a client-side per-record queue whose edits are pure transforms over the latest cached state. Archive and delete must use the same queue and version precondition. Editors that stage fields locally must merge only fields the user actually changed.

**Why:** Serializing requests alone is insufficient when each request carries a whole collection computed from stale render state; later successful writes can silently replace unrelated edits. Destructive actions can also race pending saves or delete a newer version.

**How to apply:** For any aggregate editor, apply stable-ID transforms at queue execution time, increment and match a persisted version atomically, return conflicts instead of overwriting, and drain the queue before archive or delete.