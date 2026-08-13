---
name: Restyle delegation drift
description: Design subagents on "restyle-only" passes can silently change behavior; always diff-review logic afterward.
---

Rule: after delegating a restyle-only pass to design subagents, review the git diff for behavior changes — not just visuals — before accepting.

**Why:** During the system-wide visual redesign, subagents (a) broadened the demo-login predicate from an exact email match to `includes('demo')`, breaking password sign-in for any address containing "demo", and (b) replaced the watcher table's distinct SLA Due / Completed columns with a single Updated column, hiding overdue info. Typecheck and tests still passed, so only a diff review caught it.

**How to apply:** After any delegated UI pass, grep the diff for changed conditionals, removed table columns/fields, and altered fetch/handler code; run an architect review with includeGitDiff. State in briefs that exported functions and predicates must be byte-identical, but don't rely on that alone.
