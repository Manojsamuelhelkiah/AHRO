---
name: Orval codegen numeric-constraint TDZ bug
description: Referenced numeric constraints can break the generated Zod module at load time
---

# Orval codegen: numeric constraints can cause a TDZ crash

Rule: treat generated Zod ordering as unsafe whenever OpenAPI numeric constraints are projected into reused or referenced schemas. Prefer app-layer validation when the constraint is not required for client input.

**Why:** Orval can emit `*Min` or `*Max` constants after eager top-level schemas that reference them. This causes TS2448/TS2454 and a runtime temporal-dead-zone ReferenceError when importing the generated Zod package, which can prevent the API server from starting.

**How to apply:** After any constrained numeric schema change, run dependency-aware codegen/typechecking and smoke-import the generated Zod entrypoint. If ordering is unsafe, omit output-only constraints or enforce client-input ranges in an app-layer schema instead.

Pin the generator's Zod target to the installed major rather than relying on automatic detection with pnpm catalog dependencies.

**Why:** Catalog-based version metadata can make inference select a different major version from the library consuming the generated validators.

**How to apply:** Keep the target aligned with the consuming library when changing versions. Regenerate rather than hand-edit validators, then build the shared libraries.

The same ordering failure can affect referenced string `maxLength` constraints, not just numeric ranges. Keep essential input limits in server-side validation when a reused schema emits a late `*Max` declaration.

**Why:** Schema consumers may load generated source directly rather than a server bundle, so a bundled server and a previously passing typecheck do not prove that every consumer can import it safely after regeneration or formatting.

**How to apply:** Smoke-import the generated Zod source with the same source loader used by browser regression after code generation. Do not fix ordering by hand in generated files.
