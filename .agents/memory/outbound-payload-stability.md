---
name: Outbound payload stability
description: Freeze reply references and message content before binding an idempotent provider effect.
---

An idempotent outbound operation must reuse its persisted message and reply reference, not regenerate either during retries or concurrent attempts.

**Why:** Two reminders with the same logical operation key produced different argument hashes when each composed a fresh candidate reply reference. The effect journal correctly rejected the conflict.

**How to apply:** Serialize initial message preparation, persist the exact delivery payload before dispatch, and replay that payload. Keep effect-journal hash checks intact. Changes to names, templates, timestamps, or reply references must not silently alter an already-bound operation; uncertain dispatches remain non-retryable.