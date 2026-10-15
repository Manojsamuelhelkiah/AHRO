---
name: Controlled demo email browser harness
description: Durable constraints for testing controlled Demo email delivery without reaching external providers.
---

The browser regression must replace the connector with an in-process transport while retaining the external-provider deny fence. The test-only allowance should cover only the controlled Demo email route and require an explicit test environment marker.

**Why:** The provider governance boundary evaluates opaque outbound email against every sensitive data class, not only candidate contact. A narrowly authorized local fixture therefore needs matching fake-provider policy rows across those classes, while real network calls remain denied.

**How to apply:** Keep provider mode controls and call counters in the browser-only server. Exercise the real Demo volunteer/run authorization path from the browser; use a separate test seam only for deterministic in-flight provider races. Readiness probes must use the same fake transport as dispatch. Seed verified reviewer-backed decisions in the disposable schema before case creation, so new-case adoption remains real and live governance gates are never bypassed.

Inheritance regressions must keep setup/defaults and case-state responses real,
with fake observations confined to the directory/mailbox dependency boundary.

**Why:** A setup response contains both directory choices and saved settings.
Stubbing it can hide different initial escalation defaults and scoped case
choices, while a stubbed successful save cannot demonstrate persisted inheritance.

**How to apply:** Configure initial optional settings explicitly in the owned
schema, save through authenticated production routes, and reload both inherited
and overridden cases. Create at least one eligible case after the actual
enablement save; count transport calls across the same persistent server process.