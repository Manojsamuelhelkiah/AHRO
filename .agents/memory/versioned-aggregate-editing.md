---
name: Versioned aggregate editing
description: Concurrency rule for mutable JSON aggregates and destructive lifecycle operations.
---

Mutable JSON aggregates must combine server-side optimistic version checks with a client-side per-record queue whose edits are pure transforms over the latest cached state. Archive and delete must use the same queue and version precondition. Editors that stage fields locally must merge only fields the user actually changed.

**Why:** Serializing requests alone is insufficient when each request carries a whole collection computed from stale render state; later successful writes can silently replace unrelated edits. Destructive actions can also race pending saves or delete a newer version.

**How to apply:** For any aggregate editor, apply stable-ID transforms at queue execution time, increment and match a persisted version atomically, return conflicts instead of overwriting, and drain the queue before archive or delete.

Failed-save recovery must require an explicit retry or discard, including network/5xx failures; loading a newer version is not permission to resume autosaving a draft.

**Why:** Whole-row local mirrors can silently resubmit rejected values with the refreshed version during an unrelated blur event. Network/server errors may occur after a save commits. A retry must preserve the original change intent and record identities rather than replay a toggle, regenerate IDs, or replace an entire collection.

**How to apply:** Pause editing and queued writes while failed drafts are unresolved, disable library-level automatic mutation retries, keep draft ownership above tab lifecycles, and reapply changed fields using each collection's actual identity (including phase keys) and link-set deltas. Notify the currently mounted editor when resolving instead of retaining an obsolete component's setter.

Assessment draft-loss protection uses leave warnings, not browser-persisted draft content.

**Why:** Architecture notes and rejected edits can contain sensitive client information. The requested warning-or-restoration choice allows protecting deliberate exits without leaving client drafts on a shared device.

**How to apply:** Keep unsaved work scoped to the active user and assessment, warn on reload and navigation, and offer deliberate discard. Do not introduce local/session storage as a silent fallback; any future persistent restoration needs an explicit retention/privacy design and must compare with fresh saved data before a version-checked retry.

Navigation-loss guards must outlive the routed editor and subscribe before React's history observers, not merely use a capture listener inside it.

**Why:** Router subscribers can synchronously unmount a query-selected editor during the same history event. Capture mode alone is not a substitute for a navigation guard whose lifetime is independent of that editor.

**How to apply:** Own navigation interception outside the route lifecycle, register active-editor dirty checks separately, and verify browser Back using real in-app entry. Isolated EventTarget tests cannot establish safety against router unmount ordering.

Fresh saved data must be merged into untouched draft fields; resolving a submitted snapshot must preserve edits typed after that submission.

**Why:** A response for an earlier save, or a conflict/outage refresh, is not acknowledgement of a later unblurred edit. Replacing local state on any cache update can erase that edit and incorrectly clear leave protection.

**How to apply:** Rebase local changes over refreshed data, and carry the submitted snapshot into resolution callbacks so retry/discard affects that snapshot rather than newer typing. Keep the expected editor baseline reconciled with server-only changes; those changes are not new user typing on retry. Verify ordinary retry as well as delayed responses with a second edit still focused.
