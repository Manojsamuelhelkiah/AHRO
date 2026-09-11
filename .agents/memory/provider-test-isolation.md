---
name: Provider test isolation
description: Prevent background workers from contacting recipients through development test fixtures.
---

In-process provider stubs do not protect database fixtures from the separately running API's background workers.

**Why:** A browser fixture previously acquired a “sent” approval-escalation record outside the action being tested. Authorized document fixtures can likewise be picked up by the reminder worker even when the test process stubs delivery.

**How to apply:** Pause the development API during DB-backed provider tests, clean up owned fixtures, then restart it. Browser tests must use fixtures with no live contact authorization, overdue system checks, or automatic approval triggers. Never assume a completed lifecycle alone excludes a fixture from every worker.