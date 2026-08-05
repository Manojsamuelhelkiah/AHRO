---
name: Scenario form/API mapping
description: Durable convention for mapping scenario form state to/from API inputs
---

# Scenario form/API mapping

Always map scenario form state through the single canonical mapper pair (one shared module, no page-local duplicates). Never spread raw API inputs into form state.

**Why:** page-local mapper copies silently dropped assumption overrides and legacy scalar fields on load/save round-trips.

**How to apply:** any new ScenarioInputs field must be added to the canonical mappers plus a round-trip test (load → compute → save preserves it, including legacy-field fallbacks).
