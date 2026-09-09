---
name: Orval codegen numeric-constraint TDZ bug
description: Referenced numeric constraints can break the generated Zod module at load time
---

# Orval codegen: numeric constraints can cause a TDZ crash

Rule: treat generated Zod ordering as unsafe whenever OpenAPI numeric constraints are projected into reused or referenced schemas. Prefer app-layer validation when the constraint is not required for client input.

**Why:** Orval can emit `*Min` or `*Max` constants after eager top-level schemas that reference them. This causes TS2448/TS2454 and a runtime temporal-dead-zone ReferenceError when importing the generated Zod package, which can prevent the API server from starting.

**How to apply:** After any constrained numeric schema change, run dependency-aware codegen/typechecking and smoke-import the generated Zod entrypoint. If ordering is unsafe, omit output-only constraints or enforce client-input ranges in an app-layer schema instead.
