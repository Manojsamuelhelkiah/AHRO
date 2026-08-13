---
name: DB schema drift & drizzle push
description: Dev DB can lag the Drizzle schema; drizzle-kit push fails in non-interactive shells
---

Schema columns added in `lib/db` are not automatically applied to the dev database — background features (e.g. pollers) then fail on every cycle with "Failed query" while HTTP routes may still work.

**Why:** `pnpm run push` (drizzle-kit) requires a TTY for its confirmation prompts and errors out in agent shells, so drift silently accumulates.

**How to apply:** when a query fails on a column that exists in the schema, compare `information_schema.columns` with the Drizzle schema and apply the missing DDL via `executeSql` (matching the schema exactly, e.g. `unique` constraints), or use `push-force` only when confident nothing destructive is pending.
