---
name: Rendering React components in the node test harness
description: Rendering and mounting React UI tests through esbuild and node:test
---

Assert DOM presence as a boolean or count rather than comparing a live mounted DOM node directly against null.

**Why:** A failed Node assertion can spend so long inspecting the happy-dom node and its React-owned graph that it looks like an unresolved async test instead of reporting the selector mismatch.

**How to apply:** Use `assert.equal(!!element, false)` or an element count for absence checks; scope layout selectors to the intended container rather than matching responsive classes anywhere in its subtree.

The cost-explorer test harness (esbuild bundle → `node --test`) can render real React components with `react-dom/server`'s `renderToStaticMarkup`, but three things must hold:

- The harness glob must include `*.test.tsx` and the build must set `jsx: "automatic"` (the app tsconfig uses `jsx: "preserve"`, which esbuild would otherwise pass through and node cannot parse).
- Node builtins must be externalized as both `"node:*"` **and** bare names (`...builtinModules`) — react-dom's cjs build does `require("util")`.
- Bundling cjs deps to ESM leaves externalized `require()` calls unimplemented → "Dynamic require of \"util\" is not supported". Fix with an esbuild banner: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`

**Why:** hit all three failure modes when adding the demarcation-strip UI reconciliation test.
**How to apply:** any new UI-level test in a node:test + esbuild harness; extract page JSX into a shared component so test and page render identical markup.

Mounted-component tests should keep React itself external to the esbuild bundle and clean up their scheduler resources, rather than forcing the test runner to exit after assertions.

**Why:** React's async `act` uses a dynamic `module.require("timers")` to select Node task scheduling. Bundling strips that native module method, so it falls back to browser MessageChannels. In Node those ports stay referenced: assertions pass but the worker never exits. Force-exit also produced varying, incomplete parallel-suite results rather than reliably validating every test.

**How to apply:** Use the native React package, initialize the DOM before browser-sensitive bundled modules, and unmount roots, clear query/mutation timers, and close the DOM during teardown. If a test uses the MessageChannel fallback, track and close its test-owned ports. Let Node exit naturally: a timeout after passing assertions or an unexplained change in the reported test count is an unreliable run, not a reason to add `--test-force-exit`.

Load native React DOM after installing the test DOM globals when testing text-input changes.

**Why:** React DOM captures browser/event support during module initialization. A static import before happy-dom exists can let clicks work while text-input change handlers silently fail, making controlled-input tests misleading.

**How to apply:** Dynamically import react-dom/client after DOM setup; use native input-value setters and bubbled input events, then assert both the visible value and submitted payload. Keep React external and perform normal root/DOM cleanup.

Mounted page tests that use Wouter or form libraries also need the happy-dom `location`, `history`, window event methods, and HTML element constructors installed on `globalThis` before importing the page.

**Why:** those libraries read browser globals directly rather than consistently through `window`; a partial DOM shim renders shared components but fails only when a routed page mounts.

**How to apply:** mirror the complete browser-global setup from existing mounted page suites whenever a test imports routing, forms, dialogs, or query-driven pages.

Browser-sensitive modules must initialize after the test DOM exists, not just render after it exists.

**Why:** React DOM selects input-event support at import time, and Radix selects layout-effect support at import time. Importing them before installing browser globals can silently disable controlled input updates or portal mounting even when click-driven components pass.

**How to apply:** Dynamically import mounted components and React DOM after installing the test Window. Include computed-style, custom-event and node-filter globals for real dialog focus/portal behavior, then test input changes and dialog opening rather than weakening those assertions.

Wouter instruments browser History methods at module initialization; statically importing it before creating a test Window misses that instrumentation.

**Why:** Routed component assertions may render correctly while query-only navigation never notifies subscribers, so a partial test DOM can falsely suggest broken application navigation.

**How to apply:** Initialize browser globals before importing Wouter, or mirror its History event instrumentation separately for each test-owned Window. Exercise query-only navigation and Back/Forward with the real query cache.

Development-mode server test bundles must leave Pino and its worker-backed transport packages external, unless the harness explicitly builds their worker assets.

**Why:** assertions can all pass while a bundled development logger later crashes on a missing worker module. Switching to production mode can silently skip development-only database tests, so it is not a valid workaround.

**How to apply:** externalize the logger and transport dependencies for focused esbuild test bundles, preserve the intended test environment, and require a clean process exit as well as passing assertions.

Standalone workspace test bundles must preserve transitive dependency resolution from the package that owns each imported library.

**Why:** Externalizing every package can relocate a shared library's imports into the calling artifact, where its correctly installed dependencies are not visible. The resulting module-not-found error is not evidence that those dependencies are absent from the workspace.

**How to apply:** Bundle workspace libraries and their ordinary dependencies from source when running standalone helpers, while keeping necessary native or worker-backed packages external. Use the ESM native-require banner when bundled CommonJS needs it; do not install duplicate dependencies or change the intended environment to hide resolution failures.
