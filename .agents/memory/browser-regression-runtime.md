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

**How to apply:** Keep Origin and the host seen by the guard consistent without bypassing the guard. Copy actual lifetime headers when mocking ordinary successful responses or authorization rejections; omit them only when deliberately testing session expiry. Use fixtures with the permissions required by incidental page requests, or stay on the changed setup flow rather than an unrelated planning wizard.

Playwright's direct API-request context does not inherit the browser page's same-origin Origin or the app's selected-tenant request header.

**Why:** A direct test request can receive a genuine 403 from the administrator's cross-site safeguard, or read the wrong tenant, even though an adjacent browser form succeeds.

**How to apply:** For direct requests inside a browser journey, send the page's actual Origin and currently selected tenant header. Assert the preceding read status before using its revision in a write. Do not bypass the same-site check.

Choose optional product settings explicitly for each isolated journey; do not inherit them from unrelated fixture families.

**Why:** An enabled optional product can make an incidental case-summary read hold organization-wide lifecycle locks. A defect in that separate read can stall otherwise valid administrative saves and make the changed feature appear to be the failing boundary.

**How to apply:** Inspect pending requests and lock ownership before changing authorization. Keep optional-product journeys in their own fixture tenants, and report their independent failures without changing employee consent or weakening collection gates.

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

Private-mode browser write regressions should use actual local HTTPS rather
than rewriting the browser's Origin to simulate a secure request.

**Why:** A valid proof on an HTTP browser session still fails the production
same-site safeguard. Forging the scheme would no longer exercise the real
browser-to-server security boundary.

**How to apply:** Use a test-only local TLS server and disposable certificate;
keep production HTTPS and same-origin checks unchanged.

Assertions about protected audit outcomes must wait for durable post-response
capture rather than treating the HTTP response as the end of audit persistence.

**Why:** An immediate fixture-state read can miss the final outcome even though
the mutation or rejection is complete, producing timing-dependent failures.

**How to apply:** Poll for the expected attributed audit outcomes with a bounded
assertion, then inspect the settled state. Do not use fixed sleeps or reduce the
expected audit count to accommodate the race.

Fictional browser principals must resolve from owned test identity fixtures,
not from the real identity provider. Such fixtures must not attest verified
email, MFA enrollment, or private administrator approval.

**Why:** Ordinary signed-in screens can read eligibility or display identity
even when a fake session was accepted. Sending the fictional principal to the
real provider causes missing-user failures and violates test isolation.

**How to apply:** Keep identity reads behind the isolated test process boundary,
allow only its owned principals, reject unknown identities, and leave production
authentication and professional authority checks unchanged.

For denied-pagination regressions, initiate and hold the browser request before
revoking permission, then release it to the real server after revocation. Do
not revoke first and assume the pagination control will remain present.

**Why:** A prior in-flight read or background refresh can correctly fail closed
and remove the control before the test clicks it, turning safe behavior into
a timeout.

**How to apply:** Synchronize the test at its browser request boundary, keep
live polling and server authorization enabled, and assert the denied response
and cleared content rather than relying on a stale control.
