---
name: Task merges can revert uncommitted edits
description: Background task-agent merges may clobber the main agent's uncommitted working-tree changes.
---

Background project-task merges rewrite files on main and can silently revert the main agent's uncommitted edits.

**Why:** Task agents merge into main while the main agent's work is still uncommitted; the merge wins.

**How to apply:** After a task-merge notification, re-verify recently edited files before building on them; unexpected test/typecheck failures right after a merge usually mean an edit vanished — re-apply it.
