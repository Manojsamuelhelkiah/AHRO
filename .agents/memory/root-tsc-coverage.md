---
name: Root tsc -b does not cover artifact app sources
description: Workspace-root `tsc --build` can pass while an artifact package (e.g. api-server routes) has real type errors.
---

Root `tsc -b` builds the workspace libs but does not typecheck every artifact's app sources — a badly broken `artifacts/api-server/src/routes/*.ts` still passed the root build.

**Why:** the root build graph only references the lib projects; artifact packages have their own `tsc -b tsconfig.json` typecheck scripts.

**How to apply:** before declaring API/frontend work verified, run `pnpm --filter <pkg> run typecheck` for each touched artifact package, not just the root build. Also: files can be mangled by concurrent merges after your edits — if a review reports errors you never saw, re-run the package typecheck and diff against the upstream commit before assuming your edits were at fault.
