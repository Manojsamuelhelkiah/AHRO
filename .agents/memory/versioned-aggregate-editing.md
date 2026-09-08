---
name: Versioned aggregate editing
description: Concurrency rule for mutable JSON aggregates and destructive lifecycle operations.
---

Mutable JSON aggregates must combine server-side optimistic version checks with a client-side per-record queue whose edits are pure transforms over the latest cached state. Archive and delete must use the same queue and version precondition. Editors that stage fields locally must merge only fields the user actually changed.

**Why:** Serializing requests alone is insufficient when each request carries a whole collection computed from stale render state; later successful writes can silently replace unrelated edits. Destructive actions can also race pending saves or delete a newer version.

**How to apply:** For any aggregate editor, apply stable-ID transforms at queue execution time, increment and match a persisted version atomically, return conflicts instead of overwriting, and drain the queue before archive or delete.

Conflict recovery must require an explicit retry or discard; loading a newer version is not permission to resume autosaving a rejected draft.

**Why:** Whole-row local mirrors can silently resubmit rejected values with the refreshed version during an unrelated blur event. A retry must preserve the original change intent rather than replay a toggle or replace an entire collection.

**How to apply:** Pause editing and queued writes while conflicts are unresolved, keep draft ownership above tab lifecycles, and reapply changed fields using each collection's actual identity (including phase keys) and link-set deltas. Notify the currently mounted editor when resolving instead of retaining an obsolete component's setter.