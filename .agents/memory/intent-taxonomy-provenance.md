---
name: Intent taxonomy provenance
description: Durable counting and source-linking rules for the HRO intent corpus and future routing work.
---

Treat fixed reference outcomes, grouping parents, external aliases, client custom intents, retired rows, and source-supported candidates as separate classes. Source relationships must be typed as exact-label, family-scope, or curated-decomposition; only exact-label relationships may become aliases.

**Why:** The remembered 69-row baseline has no preserved row-level snapshot, while SAP product documentation and public HR datasets use different granularities. Forcing labels into one count creates unsupported provenance and duplicate outcomes.

**How to apply:** Any corpus count, UI summary, migration, cost model, or runtime registry must state which class it counts. New candidates require product approval and modelling before joining the fixed reference baseline. Keep agent ownership separate from deterministic action/tool execution.