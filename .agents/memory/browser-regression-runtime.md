---
name: Browser regression runtime
description: Workspace Playwright tooling is independent from the browser used by the UI tester.
---

A successful UI testing-subagent run does not prove the workspace's configured Playwright regression runner can launch its own browser or video recorder.

Before retrying validation after a browser runner failure, confirm its isolated server ports have been released. Do not enable server reuse to bypass an occupied port.

**Why:** A validation retry can encounter a temporarily occupied readiness endpoint even after the prior run reports failure. Reusing that server risks testing against stale fixtures.

**How to apply:** Check the harness readiness endpoints and running processes before retrying; preserve isolated-server ownership and fail-closed configuration.

**Why:** The tester's browser and the workspace runner have independent runtime installations, including version-specific video recorders.

**How to apply:** Treat a missing browser executable as a tooling/setup failure, not an application regression or permission to skip validation. Use the workspace's native Chromium configuration where available, preserve standard Playwright behavior elsewhere, and provision the matching Playwright recorder when video capture is enabled.

The UI tester's browser-code runtime does not necessarily expose workspace environment variables, even when its shell can report that a variable is configured.

**Why:** The browser-code sandbox and workspace shell have separate runtime boundaries; a configured credential is not automatically injected into both.

**How to apply:** For a credential-backed development check that cannot run in the tester, use the workspace Playwright runner with a direct environment reference inside test code. Never copy the secret through chat, tool output, generated files, or test reports.

The isolated browser-regression Vite server and the real Clerk preview must use separate dependency-optimizer caches.

**Why:** Their auth aliases produce different dependency graphs. Concurrent servers sharing a cache can overwrite generated React chunks while the other server still serves its original graph, causing invalid-hook-call failures only in the real preview even when isolated browser tests pass.

**How to apply:** Keep test-auth dependency caches separate from normal development caches. After a cache collision, rebuild the affected generated cache and verify the real signed-in preview, not only the isolated harness.

Same-site privileged browser tests must preserve the browser-facing host through their API proxy, and mocked responses must retain session-lifetime metadata from a real current-session response.

**Why:** Rewriting the upstream Host to a different loopback port makes genuine same-origin browser writes fail the existing cross-site guard. Dropping admin lifetime headers from a mocked rejection can instead make the protected session boundary remount the page, hiding the intended error or dialog.

**How to apply:** Keep Origin and the host seen by the guard consistent without bypassing the guard. Copy actual lifetime headers when mocking an ordinary authorization rejection; omit them only when deliberately testing session expiry. Use fixtures with the permissions required by incidental page requests, or stay on the changed setup flow rather than an unrelated planning wizard.

Browser layout assertions must tolerate nodes being replaced during successful mutation-triggered refetches; never put a mutation click inside the retry wrapper.

**Why:** Locator scrolling can fail on a detached node even when the refreshed replacement is visible and valid. Retrying the mutation itself could mask duplicate delivery.

**How to apply:** Retry only reacquired scrolling and bounding-box assertions for a bounded interval, then perform one click and retain the exact request-count assertion.

An isolated search path is not sufficient when historical migration SQL
contains explicitly shared-schema foreign-key references.

**Why:** Disposable browser schemas once kept foreign keys to everyday
organization/case tables despite having no shared search-path fallback.
Those references can couple test startup or teardown to real client records.

**How to apply:** Rewrite shared-qualified references only in disposable replay
copies, never historical migration files, and assert that every test FK stays
inside its owned schema. Fail closed rather than reintroducing shared fallback.

Controlled provider admission and administrator proof simulation can require
different process modes in the same isolated browser harness.

**Why:** A mailbox fixture admitted only in test mode failed once the admin
adapter modeled development/production semantics. Capturing only its provider
scope would also discard a separately entered provider-deny scope.

**How to apply:** Admit dependencies before switching proof modes and capture
the controlled provider and deny fence together. Do not weaken production
dependency admission or rely on browser headers to recreate either scope.
