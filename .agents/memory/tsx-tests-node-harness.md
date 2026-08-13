---
name: Rendering React components in the node test harness
description: How to run .tsx UI tests through the esbuild + node:test harness in cost-explorer
---

The cost-explorer test harness (esbuild bundle → `node --test`) can render real React components with `react-dom/server`'s `renderToStaticMarkup`, but three things must hold:

- The harness glob must include `*.test.tsx` and the build must set `jsx: "automatic"` (the app tsconfig uses `jsx: "preserve"`, which esbuild would otherwise pass through and node cannot parse).
- Node builtins must be externalized as both `"node:*"` **and** bare names (`...builtinModules`) — react-dom's cjs build does `require("util")`.
- Bundling cjs deps to ESM leaves externalized `require()` calls unimplemented → "Dynamic require of \"util\" is not supported". Fix with an esbuild banner: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`

**Why:** hit all three failure modes when adding the demarcation-strip UI reconciliation test.
**How to apply:** any new UI-level test in a node:test + esbuild harness; extract page JSX into a shared component so test and page render identical markup.
