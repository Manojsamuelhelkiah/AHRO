---
name: Stale composite declarations break type checks
description: Why `tsc --noEmit` in a package can report phantom errors from workspace libs
---

Packages reference workspace libs (e.g. `lib/db`) via TypeScript project references with `composite` + `emitDeclarationOnly`. Plain `tsc -p ... --noEmit` reads the libs' **built** `dist/*.d.ts`, not their sources — if a lib's source changed but wasn't rebuilt, the type check reports phantom errors (or misses real ones).

**Why:** A "non-nullable column" type error persisted even though the schema source was already nullable; the culprit was stale `lib/db/dist` declarations.

**How to apply:** Use `tsc -b` for typecheck scripts (it rebuilds references first), or run `pnpm exec tsc -b lib/db --force` when a type error contradicts the source you're reading.
