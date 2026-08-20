---
name: Cost-explorer model conventions
description: Rules the HRO cost-benefit roll-up must keep as it evolves
---

- The assumptions register is the single source of truth: every step unit cost and model factor must derive from a registered assumption, every surfaced scenario input must change the roll-up result, and new response fields must be added to the OpenAPI schema (generated zod strips unknown fields).
- Semantics: uncontained agentic transactions still incur AI/infra cost but fall back to full as-is human handling with zero benefit; non-adopted volume incurs nothing. Advanced inputs are optional — absence (not defaults) is what lowers the confidence score, so omit rather than prefill defaults. Adoption/HITL sampling deliberately exclude 0 (min 1%). Clearing an advanced form field must omit the field from API inputs (not submit 0), so empty-to-undefined preprocessing is required for all optional numeric fields including per-FC record entries.
- User-facing analyses and exports must load one validated active rate snapshot and pass it through every roll-up, including sensitivity nudges and workbook reference pricing. Default model per-call rates must equal role defaults; scenario overrides remain highest priority.

  **Why:** Otherwise quotes, sensitivity views, and displayed model assumptions can silently disagree after a commercial owner publishes a new rate set.

  **How to apply:** For any new path that calls the pricing engine, resolve scenario override → active snapshot → code baseline, keep duplicate default-model fields synchronized and validated, and surface the rate reference in exported/customer-facing material.
