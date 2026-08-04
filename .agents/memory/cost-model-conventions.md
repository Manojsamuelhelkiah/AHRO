---
name: Cost-explorer model conventions
description: Rules the HRO cost-benefit roll-up must keep as it evolves
---

- The assumptions register is the single source of truth: every step unit cost and model factor must derive from a registered assumption, every surfaced scenario input must change the roll-up result, and new response fields must be added to the OpenAPI schema (generated zod strips unknown fields).
- **Why:** a completion review rejected the model for duplicated cost literals and dead inputs — a visible register that doesn't drive the math is treated as silent model drift.
- **How to apply:** when adding a cost factor: register the assumption, wire it into the engine, include it in appliedAssumptions, update the API spec + codegen, and extend the roll-up tests to assert the input moves the output and rows/buckets/domains reconcile with totals.
- Semantics: uncontained agentic transactions still incur AI/infra cost but fall back to full as-is human handling with zero benefit; non-adopted volume incurs nothing. Advanced inputs are optional — absence (not defaults) is what lowers the confidence score, so omit rather than prefill defaults. Adoption/HITL sampling deliberately exclude 0 (min 1%).
