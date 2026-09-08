---
name: Degraded intent-corpus actions
description: Capability boundary for Scenario and Calibration when custom-intent storage is unavailable.
---

When the intent corpus is degraded, block operations whose correctness may depend on missing custom intents, but keep operations available when their inputs are provably limited to built-in reference data.

**Why:** Treating unavailable custom intents as an empty set produces plausible but partial calculations. Blocking every action is also unnecessarily disruptive because flow-class, global, token-only, and known reference-intent calibration can remain correct.

**How to apply:** Classify each action from its actual inputs at both the UI and API boundaries. Scenario-wide calculations require the complete corpus. Calibration may proceed for built-in references; custom or unknown intent keys must fail closed. Retry recovery should derive control state from the refreshed corpus response rather than require a reload.