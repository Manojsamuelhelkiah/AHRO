---
name: Controlled demo email browser harness
description: Durable constraints for testing controlled Demo email delivery without reaching external providers.
---

The browser regression must replace the connector with an in-process transport while retaining the external-provider deny fence. The test-only allowance should cover only the controlled Demo email route and require an explicit test environment marker.

**Why:** The provider governance boundary evaluates opaque outbound email against every sensitive data class, not only candidate contact. A narrowly authorized local fixture therefore needs matching fake-provider policy rows across those classes, while real network calls remain denied.

**How to apply:** Keep provider mode controls and call counters in the browser-only server. Exercise the real Demo volunteer/run authorization path from the browser; use a separate test seam only for deterministic in-flight provider races.