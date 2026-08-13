---
name: Task-merge file corruption
description: Platform task merges can scramble a heavily-edited file; verify with tsc after every merge and repair from the last good commit.
---

# Task-merge file corruption

A platform task merge can silently corrupt a file that both the merge and recent
local checkpoints touched heavily (observed: whole route handlers swapped with
each other's bodies, undefined identifiers, duplicated routes).

**Why:** the auto-merge is not semantic; when both sides rewrote overlapping
regions it can interleave hunks into nonsense — and it lands as a normal commit,
so nothing fails until the next typecheck.

**How to apply:** after any `[MERGED]` task notification touching files you also
edited, run the per-package `tsc -b` before building on top. If a file is
scrambled, don't hand-fix hunk by hunk: `git checkout <last-good-commit> -- <file>`
(find it by grepping candidate commits for a marker string you added), then
re-apply the merge's *intended* additions, which are usually small and visible in
the merge commit's stat/diff of other files.
