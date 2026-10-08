---
name: Provider test isolation
description: Prevent background workers from contacting recipients through development test fixtures.
---

In-process provider stubs do not protect database fixtures from the separately running API's background workers.

Full-stack browser regressions must isolate all database state, not just case delivery state.

**Why:** Offline synthetic mutations can still enqueue protected audit checkpoints. A shared-schema worker could deliver those after the test ends, despite a request-local provider-deny fence.

**How to apply:** Initialize a disposable migrated schema before importing application database modules, verify relation resolution, and drop only the owned schema on teardown. Keep test authentication loopback-only and unavailable to production builds.

Isolated migration replay must exclude `public` from `search_path`, even as an extension fallback.

**Why:** An unqualified `DROP INDEX IF EXISTS` can resolve a same-named public index when it does not yet exist in the disposable schema, silently damaging the shared schema while the isolated test passes.

**How to apply:** Use only the owned schema in the search path. Provide narrowly scoped extension wrappers when necessary rather than adding shared application schemas as fallbacks.

**Why:** A browser fixture previously acquired a “sent” approval-escalation record outside the action being tested. Authorized document fixtures can likewise be picked up by the reminder worker even when the test process stubs delivery.

**How to apply:** Pause the development API during DB-backed provider tests, clean up owned fixtures, then restart it. Browser tests must use fixtures with no live contact authorization, overdue system checks, or automatic approval triggers. Never assume a completed lifecycle alone excludes a fixture from every worker.

Test workers must also restrict claims to their own fixture tenants.

**Why:** Separate test processes share the database but not their provider stubs. An unscoped worker can claim another test's deletion job and apply the wrong stubbed effects.

**How to apply:** Scope test recovery and deletion claims explicitly, preserving normal production scheduling. Verify isolation with concurrent focused tests, not only serial passes.

Interactive UAT isolation must survive privacy minimization and remain effective before bounded worker selection, not just before dispatch.

**Why:** Notes are mutable and may be cleared by retention controls. Filtering synthetic work after a queue limit can also starve genuine work even when every external call is blocked.

**How to apply:** Bind ownership durably outside minimizable case content, exclude isolated work in selection and atomic claim predicates, and retain a final provider-boundary check. Test both absence of synthetic side effects and continued processing of later genuine queue items.

Permission-gated test tools need an authorized-success regression as well as a denial regression.

**Why:** A deterministic receipt identity was once mistaken for the authenticated principal. Denial-only tests passed, incorrectly suggesting that a reviewer needed more permissions even though no reviewer could succeed.

**How to apply:** Keep receipt/correlation identities separate from authority principals, and verify both outcomes with controlled test-only grants before attributing a blocked journey to user configuration.

Fixture teardown must also serialize against live organization bootstrap
writers: lock the synthetic parent organization and remove its dynamically
seeded configuration children in the same transaction as parent deletion.

**Why:** The running API can create inert connector/settings rows while an
isolated test is executing, causing intermittent foreign-key teardown failures.

**How to apply:** Apply this only to explicitly scoped synthetic fixtures;
never disable production foreign keys or append-only history guards.

Crash regressions must count fake provider dispatches and receipts outside the
process being terminated.

**Why:** A killed worker loses its counters and in-memory receipts. Observing
only the restarted worker can falsely report no duplicate calls while missing
what the original worker already sent.

**How to apply:** Keep a surviving parent-side transport ledger, confirm a real
hard-kill exit, and inspect both immediate recovery and recovery after the
ambiguity window without refunding or rewriting budget reservations.