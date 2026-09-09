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

**How to apply:** after any merge touching files you also edited, typecheck
before building on top. If a file is scrambled, don't hand-fix hunk by hunk —
restore it from the last good commit and re-apply the merge's intended
additions, which are usually small.

Corruption can RECUR after a repair: a later platform commit re-landed the
scrambled version over an already-repaired file (fourth occurrence). The merge
commit's own hunks may be internally scrambled too — don't copy them verbatim;
reconstruct each feature's intent against the clean base. And never swallow
typecheck output (`tsc -b . >/dev/null 2>&1;` hid the re-corruption); always
inspect tsc's exit/output when re-verifying.

An isolated task branch can already contain the same invalid interleaving before
it reaches main. Treat that branch as evidence of intent, not as an automatically
trustworthy restore source; use the last typechecked main version as the base and
reapply only coherent behavior.
