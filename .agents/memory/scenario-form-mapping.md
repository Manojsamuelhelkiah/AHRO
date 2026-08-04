---
name: Scenario form/API mapping
description: Rule for mapping ScenarioInputs between API and form state in cost-explorer
---
Use one canonical mapper pair (`toApiInputs` / `fromApiInputs` in cost-explorer's scenario-mapper lib) for scenario form ⇄ API conversion; never spread raw API inputs into form state.

**Why:** Spreading raw `inputs` left a stale top-level `assumptionOverrides` key in form state, so "Reset all to defaults" silently kept applying old overrides on recompute/save. Duplicate mappers also drifted (one missed containment fields).

**How to apply:** Any new ScenarioInputs field with a form-side private representation must be explicitly destructured out in `fromApiInputs` and rebuilt in `toApiInputs`; extend the mapper tests when adding fields.
