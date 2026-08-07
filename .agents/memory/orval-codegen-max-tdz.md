---
name: Orval codegen max-constraint TDZ bug
description: Spec fields with `maximum` on additionalProperties break the generated zod module at load time
---

# Orval codegen: `maximum` constraints cause a TDZ crash

Rule: in `lib/api-spec/openapi.yaml`, avoid `maximum` (with `minimum`) on `additionalProperties` of record fields; enforce ranges in the app-layer form schema instead.

**Why:** Orval emits `*MinN` constants inline before the schema, but defers `*MaxN` constants to end-of-file. Top-level schema consts reference them before declaration → TS2448/TS2454 and a runtime temporal-dead-zone ReferenceError when importing `@workspace/api-zod`, which can prevent the API server from starting.

**How to apply:** When adding validated numeric ranges to the spec, either omit `maximum` and validate in `scenario-form.ts`-style app schemas, or verify after codegen that `lib/api-zod/src/generated/api.ts` typechecks and imports cleanly (grep for `Max` constants referenced before declaration).
