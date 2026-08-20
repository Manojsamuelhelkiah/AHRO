---
name: OpenAPI integer persistence
description: Prevent fractional API values from drifting away from stored inputs and derived calculation snapshots.
---

In this workspace, an OpenAPI field declared as `type: integer` can generate request validation that only checks for a number and a minimum. Any count or duration that must remain whole needs an explicit server-boundary integer check before persistence.

**Why:** A fractional value can otherwise be stored unchanged while the calculation model rounds it, so the saved assumptions, displayed recommendation, and reopened form no longer represent the same input.

**How to apply:** For persisted inputs that feed derived snapshots, validate integrality, normalize accepted values once, then use that same normalized object for both storage and calculation.