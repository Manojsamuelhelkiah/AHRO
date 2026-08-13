---
name: Webhook session durability
description: DB-backed webhook sessions need claim-based finalization and guarded saves
---

Long-lived webhook-driven sessions (e.g. Twilio voice calls) persisted in a DB row must treat finalization as an atomic claim, not a flag write.

**Why:** a turn handler that snapshots the row, awaits an LLM, then writes the whole session back can race a concurrent finalize (status callback / expiry / startup recovery) — the stale write flips `finalized` back to false, and a later retry duplicates side effects (timeline rows, approvals, emails). Completion review rejects the naive version.

**How to apply:**
- Mutable-state saves: `UPDATE ... WHERE token = ? AND finalized = false` — a stale save becomes a no-op instead of corrupting a finalized row; never include `finalized` in turn saves.
- Finalize via a time-limited LEASE column plus a per-claim OWNER (fencing token), not the terminal flag: claim with `SET lease=now(), owner=uuid WHERE finalized=false AND (lease IS NULL OR lease expired) RETURNING *`; run side effects from the RETURNING row; set `finalized=true` only after everything persisted, fenced on owner. A crash mid-way leaves an expired lease the startup sweep reclaims; a stalled finalizer that lost its lease gets zero-row updates and must abort. Progress-marker writes should also renew the lease (heartbeat) and be owner-fenced. Turn/state saves must be blocked while an unexpired lease is held. (Both a claim that sets `finalized=true` up front and an unfenced lease get rejected in review.)
- Make each side effect idempotent AT THE DB BOUNDARY: per-step progress markers (jsonb) are not enough — a crash between effect and marker duplicates it. Give side-effect tables a nullable unique `idempotency_key` column and insert with on-conflict-do-nothing using per-session/per-step keys.
- External sends (email/SMS) can't be exactly-once: commit a send-intent marker BEFORE the send (at-most-once); on resume with intent-but-unknown-result, never resend — raise an idempotent human-verify approval instead.
- If side effects fail and no human alert could be raised, release the lease so recovery retries; if the alert was raised, mark terminal to avoid loops.
- This also covers multi-instance deployments; process-local Sets are only a cheap same-process reentrancy shortcut.
