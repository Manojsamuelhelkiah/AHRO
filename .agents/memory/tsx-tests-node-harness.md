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

Mounted-component tests should keep React itself external to the esbuild bundle and clean up their scheduler resources, rather than forcing the test runner to exit after assertions.

**Why:** React's async `act` uses a dynamic `module.require("timers")` to select Node task scheduling. Bundling strips that native module method, so it falls back to browser MessageChannels. In Node those ports stay referenced: assertions pass but the worker never exits. Force-exit also produced varying, incomplete parallel-suite results rather than reliably validating every test.

**How to apply:** Use the native React package, initialize the DOM before browser-sensitive bundled modules, and unmount roots, clear query/mutation timers, and close the DOM during teardown. If a test uses the MessageChannel fallback, track and close its test-owned ports. Let Node exit naturally: a timeout after passing assertions or an unexplained change in the reported test count is an unreliable run, not a reason to add `--test-force-exit`.

Mounted page tests that use Wouter or form libraries also need the happy-dom `location`, `history`, window event methods, and HTML element constructors installed on `globalThis` before importing the page.

**Why:** those libraries read browser globals directly rather than consistently through `window`; a partial DOM shim renders shared components but fails only when a routed page mounts.

**How to apply:** mirror the complete browser-global setup from existing mounted page suites whenever a test imports routing, forms, dialogs, or query-driven pages.
