---
name: React Hook Form runtime values
description: Version-specific form initialization and numeric serialization behavior that can survive TypeScript and resolver validation.
---

Pass synchronously loaded defaults as an object, not as a callback returning an object. In the installed React Hook Form version, the callback form is treated as asynchronous and the library calls `.then` on its result.

Also do not assume a coercing schema changes the values returned by `getValues()`. Register number inputs with numeric conversion and parse the complete draft before building an API payload.

**Why:** Both mistakes type-checked but failed only in the authenticated browser flow: initialization crashed at runtime, then a numeric field was serialized as a string and rejected by the API.

**How to apply:** For forms that load browser storage synchronously, compute defaults before `useForm`. At any mutation boundary, parse the full draft and serialize the parsed result rather than raw form state.